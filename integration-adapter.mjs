#!/usr/bin/env node
// integration-adapter.mjs - hardened local HTTP API (HMAC, persistent dedupe,
// schema, post-auth rate limit, body limit). Hybrid v2+v1: retains v2 security
// (post-auth rate limiting, HMAC, persistent dedupe) and re-adds control-plane
// actions (suggestConfig, stageConfig, listChannels) with strict validation.
import { createServer } from 'node:http';
import { readFileSync, appendFileSync, existsSync, statSync, unlinkSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { startRotationWatcher } from './log-rotation.mjs';
import { readEnv, readGuildId, readEnvInt } from './lib/env.mjs';
import { atomicWriteJson } from './lib/atomic.mjs';
import { getGuildChannels } from './lib/discord.mjs';
import { controlPlanePatchSchema, schemaError, diffConfigs, mergePartialUpdate } from './lib/config.mjs';
import { isWindows } from './lib/platform.mjs';
import { readJsonSafe } from './lib/util.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const _rotLogs = [join(__dirname, 'adapter.log'), join(__dirname, 'adapter-seen.jsonl')];
  startRotationWatcher(_rotLogs);
} catch {}
const PORT = readEnvInt('ADAPTER_PORT', 3415, 1024, 65535);
// POSIX hardening: bind a Unix domain socket (mode 0600) instead of TCP when
// ADAPTER_SOCKET is set — filesystem permissions replace localhost-as-trust.
const SOCKET_PATH = !isWindows ? readEnv('ADAPTER_SOCKET') : null;
const STATE_FILE = join(__dirname, 'bot-state.json');
const LOG_FILE = join(__dirname, 'adapter.log');
const SEEN_FILE = join(__dirname, 'adapter-seen.jsonl');
const MAX_BODY = 64 * 1024;
const HMAC_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 60;

const ADAPTER_TOKEN = readEnv('ADAPTER_TOKEN');
if (!ADAPTER_TOKEN) {
  console.error('FATAL: ADAPTER_TOKEN not found. Copy .env.example to .env and generate a token with:');
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

const ALLOWLIST = new Set(['getStatus','suggestConfig','stageConfig','diagnose','readLogs','listChannels']);
// Security relies on the strict allowlist above: any action outside it is
// rejected before validation. (A separate blocklist was redundant — it could
// only ever reject actions the allowlist already rejects.)

// Dangerous key names for stageConfig - EXACT lowercase match
const BLOCKED_EXACT_KEYS = new Set([
  'token','tokenenv','adapter_token','secret','password',
  'ownerid','owner','__proto__','constructor','prototype',
  'path','paths','port','ports','runtime','pid','pidfile','lockfile',
  'statefile','logfile','logfiles','stalelockms','gracefulstopms',
  'queue','queues','maxlengths','ratelimit','rate_limits',
]);

const SCHEMAS = {
  getStatus: { params: 'empty' },
  diagnose: { params: 'empty' },
  listChannels: { params: 'empty' },
  suggestConfig: { params: 'object' },
  // stageConfig — stages a config change — does NOT apply it live, requires config-manager.mjs apply afterward
  stageConfig: { params: 'stageConfig' },
  readLogs: { params: 'readLogs' },
};

function validateParams(action, params) {
  const schema = SCHEMAS[action];
  if (!schema) return 'unknown action';
  if (schema.params === 'empty') {
    if (params && Object.keys(params).length) return 'params must be empty';
    return null;
  }
  if (schema.params === 'object') {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return 'params must be object';
    return null;
  }
  if (schema.params === 'readLogs') {
    if (!params) return null;
    if (typeof params.lines !== 'undefined') {
      const n = Number(params.lines);
      if (!Number.isInteger(n) || n < 1 || n > 100) return 'lines must be 1-100';
    }
    const extra = Object.keys(params).filter(k => k !== 'lines');
    if (extra.length) return `unexpected params: ${extra.join(',')}`;
    return null;
  }
  if (schema.params === 'stageConfig') {
    if (!params || typeof params !== 'object') return 'params must be object';
    if (typeof params.schemaVersion !== 'number') return 'missing schemaVersion number';
    // Layer 1 (security, cannot be expressed in a schema): top-level allowlist
    // + deep scan for dangerous keys — must run BEFORE zod parsing.
    const allowedTop = new Set(['schemaVersion', 'logging', 'autorole']);
    for (const k of Object.keys(params)) {
      if (!allowedTop.has(k)) return `top-level key not allowed: ${k}`;
      if (BLOCKED_EXACT_KEYS.has(k.toLowerCase())) return `blocked key: ${k}`;
    }
    const DANGEROUS = BLOCKED_EXACT_KEYS;
    function deepCheck(obj, path='') {
      for (const [k,v] of Object.entries(obj)) {
        const lk = k.toLowerCase();
        if (DANGEROUS.has(lk)) return `blocked key at ${path}${k}`;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const err = deepCheck(v, `${path}${k}.`);
          if (err) return err;
        }
      }
      return null;
    }
    const deepErr = deepCheck(params);
    if (deepErr) return deepErr;
    // Layer 2 (types & ranges): the SAME zod patch schema derived from
    // lib/config.mjs controlPlaneSchema — no duplicated hand-written checks
    // that could drift from the runtime schema.
    const parsed = controlPlanePatchSchema.safeParse(params);
    if (!parsed.success) return `invalid params: ${schemaError(parsed.error)}`;
    return null;
  }
  return null;
}

// Dedupe maps: id -> timestamp(ms). Pruned periodically so long-running
// adapters stay memory-bounded (previously Sets only cleaned at boot).
const REQUEST_ID_TTL_MS = 24 * 3600 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;
const seenRequestIds = new Map();
const seenNonces = new Map();
function loadSeen() {
  try {
    if (!existsSync(SEEN_FILE)) return;
    const lines = readFileSync(SEEN_FILE,'utf8').split('\n').filter(Boolean);
    const now = Date.now();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const ts = new Date(obj.ts).getTime();
        if (obj.requestId && now - ts < REQUEST_ID_TTL_MS) seenRequestIds.set(obj.requestId, ts);
        if (obj.nonce && now - ts < NONCE_TTL_MS) seenNonces.set(obj.nonce, ts);
      } catch {}
    }
  } catch {}
}
loadSeen();
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of seenRequestIds) if (now - t > REQUEST_ID_TTL_MS) seenRequestIds.delete(k);
  for (const [k, t] of seenNonces) if (now - t > NONCE_TTL_MS) seenNonces.delete(k);
}, 60 * 1000).unref();
function persistSeen({ requestId, nonce }) {
  try {
    const entry = JSON.stringify({ ts: new Date().toISOString(), requestId, nonce });
    appendFileSync(SEEN_FILE, entry + '\n');
  } catch {}
}

const rateMap = new Map();
const authFailMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const arr = rateMap.get(ip) || [];
  const recent = arr.filter(t => now - t < RATE_LIMIT_WINDOW);
  recent.push(now);
  rateMap.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}
function recordAuthFailure(ip) {
  const now = Date.now();
  const arr = authFailMap.get(ip) || [];
  const recent = arr.filter(t => now - t < RATE_LIMIT_WINDOW);
  recent.push(now);
  authFailMap.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of rateMap) {
    const recent = arr.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (recent.length) rateMap.set(ip, recent); else rateMap.delete(ip);
  }
  for (const [ip, arr] of authFailMap) {
    const recent = arr.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (recent.length) authFailMap.set(ip, recent); else authFailMap.delete(ip);
  }
}, 60000);

const circuit = { failures:0, openUntil:0 };
function isCircuitOpen(){ return Date.now() < circuit.openUntil; }
function recordCircuit(ok){ if(ok){ circuit.failures=0; return; } circuit.failures++; if(circuit.failures>=3) circuit.openUntil = Date.now()+15000; }

function log(line){
  const l = `${new Date().toISOString()} [adapter] ${line}`;
  console.log(l);
  try{ appendFileSync(LOG_FILE, l+'\n'); }catch{}
}
function readState(){ return readJsonSafe(STATE_FILE) || {runtime:null,pid:null}; }
function fileAgeSec(path){ try{ return Math.round((Date.now()-statSync(path).mtimeMs)/1000); }catch{ return null; } }

function authReject(res, ip, error){
  if (recordAuthFailure(ip)) {
    res.writeHead(429,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:false,error:'rate_limited',detail:'too many failed authentications',retryAfterMs:RATE_LIMIT_WINDOW}));
    return;
  }
  res.writeHead(401,{'Content-Type':'application/json'});
  res.end(JSON.stringify({ok:false,error}));
}

const server = createServer(async (req,res)=>{
  const ip = req.socket.remoteAddress || 'unknown';
  // Unauthenticated local diagnostics (no secrets in health-state by design).
  // Safe because the adapter only listens on loopback/Unix socket.
  if(req.method==='GET' && (req.url==='/health' || req.url==='/metrics')){
    if(isRateLimited(ip)){
      res.writeHead(429,{'Content-Type':'text/plain'}); res.end('rate_limited'); return;
    }
    if(req.url==='/health') return handleHealth(res);
    return handleMetrics(res);
  }
  if(req.method!=='POST' || req.url!=='/adapter/request'){
    res.writeHead(404,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:false,error:'not_found'}));
    return;
  }
  let bodyChunks=[]; let totalBytes=0; let tooLarge=false;
  req.on('data',c=>{
    if(tooLarge) return;
    bodyChunks.push(c);
    totalBytes += Buffer.byteLength(c);
    if(totalBytes > MAX_BODY){
      tooLarge=true;
      try{ req.destroy(); }catch{}
    }
  });
  req.on('end', async ()=>{
    let body='';
    if(!tooLarge){
      body = Buffer.concat(bodyChunks).toString('utf8');
    }
    if(tooLarge){
      res.writeHead(413,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'body_too_large',max:MAX_BODY}));
      return;
    }
    const started = Date.now();
    const headerToken = req.headers['x-adapter-token'] || req.headers['authorization']?.replace(/^Bearer\s+/i,'');
    let tokenOk = false;
    if(headerToken){
      try{
        const a = Buffer.from(String(headerToken),'utf8');
        const b = Buffer.from(ADAPTER_TOKEN,'utf8');
        tokenOk = a.length===b.length && timingSafeEqual(a,b);
      }catch{ tokenOk=false; }
    }
    if(!tokenOk){
      authReject(res, ip, 'unauthorized');
      return;
    }
    const timestamp = req.headers['x-timestamp'];
    const nonce = req.headers['x-nonce'];
    const signature = req.headers['x-signature'];
    if(!timestamp || !nonce || !signature){
      authReject(res, ip, 'missing_hmac_headers');
      return;
    }
    const tsNum = Number(timestamp);
    if(!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > HMAC_WINDOW_MS){
      authReject(res, ip, 'bad_timestamp');
      return;
    }
    const payloadToSign = `${timestamp}.${nonce}.${body}`;
    const expected = createHmac('sha256', ADAPTER_TOKEN).update(payloadToSign).digest('hex');
    let sigOk = false;
    try{
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(String(signature), 'utf8');
      sigOk = a.length===b.length && timingSafeEqual(a,b);
    }catch{ sigOk=false; }
    if(!sigOk){
      authReject(res, ip, 'bad_signature');
      return;
    }

    if(isRateLimited(ip)){
      res.writeHead(429,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'rate_limited',retryAfterMs:RATE_LIMIT_WINDOW}));
      return;
    }
    if(seenNonces.has(nonce)){
      res.writeHead(409,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'duplicate_nonce'}));
      return;
    }

    let payload;
    try{ payload = JSON.parse(body); }catch{ res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'invalid_json'})); return; }

    const { requestId, identity, action, params } = payload;
    const rid = requestId || `auto-${Date.now()}`;
    log(`request ${rid} action=${action} identity=${identity} ip=${ip}`);

    if(seenRequestIds.has(rid)){
      res.writeHead(409,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'duplicate_requestId',requestId:rid}));
      return;
    }
    seenRequestIds.set(rid, Date.now());
    seenNonces.set(nonce, Date.now());
    persistSeen({ requestId: rid, nonce });

    if(isCircuitOpen()){
      res.writeHead(503,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'circuit_open',retryAfterMs: circuit.openUntil-Date.now()}));
      return;
    }
    if(!ALLOWLIST.has(action)){
      res.writeHead(403,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'action_not_allowlisted',action,allowlist:[...ALLOWLIST]}));
      return;
    }
    const paramErr = validateParams(action, params);
    if(paramErr){
      res.writeHead(400,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'invalid_params',detail:paramErr}));
      return;
    }

    const timeoutMs = 5000;
    let timer;
    const timeoutPromise = new Promise((_,rej)=> timer=setTimeout(()=>rej(new Error('timeout')), timeoutMs));
    try{
      const result = await Promise.race([ handleAction(action, params, identity), timeoutPromise ]);
      clearTimeout(timer);
      recordCircuit(true);
      const ms = Date.now()-started;
      log(`request ${rid} ok in ${ms}ms`);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,requestId:rid,action,result,tookMs:ms}));
    }catch(e){
      clearTimeout(timer);
      recordCircuit(false);
      const code = e.message==='timeout'?504:500;
      const msg = String(e?.message||'error').slice(0,200);
      res.writeHead(code,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:msg,requestId:rid}));
    }
  });
});

// ——— local diagnostics endpoints (GET /health, GET /metrics) ———
function readHealthSafe(){ return readJsonSafe(join(__dirname,'health-state.json')) || {}; }

function handleHealth(res){
  const h = readHealthSafe();
  const r = h.runtime || {};
  const body = JSON.stringify({
    ok: true,
    gateway: r.gatewayState ?? 'unknown',
    uptimeSec: r.uptimeSec ?? null,
    memory: r.memory ?? null,
    pipeline: h.pipeline ?? null,
    lastEvent: h.lastEvent ?? null,
    lastError: h.lastError ?? null,
    healthSnapshotAgeSec: fileAgeSec(join(__dirname,'health-state.json')),
  });
  res.writeHead(200, {'Content-Type':'application/json'});
  res.end(body);
}

function promLabelSafe(s){ return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); }
function handleMetrics(res){
  const h = readHealthSafe();
  const r = h.runtime || {};
  const p = h.pipeline || {};
  const queues = Object.keys(p.queueDepth || { moderation:0, member:0, server:0, voice:0, message:0 });
  const lines = [
    '# HELP al_bot_up Gateway websocket connectivity (1 connected)',
    '# TYPE al_bot_up gauge',
    `al_bot_up ${r.gatewayState === 'connected' ? 1 : 0}`,
    '# HELP al_bot_health_snapshot_age_seconds Age of health-state.json snapshot',
    '# TYPE al_bot_health_snapshot_age_seconds gauge',
    `al_bot_health_snapshot_age_sec ${fileAgeSec(join(__dirname,'health-state.json')) ?? -1}`,
    '# HELP al_bot_uptime_seconds Gateway process uptime',
    '# TYPE al_bot_uptime_seconds gauge',
    `al_bot_uptime_sec ${r.uptimeSec ?? 0}`,
    '# HELP al_bot_memory_rss_bytes Resident memory of gateway process',
    '# TYPE al_bot_memory_rss_bytes gauge',
    `al_bot_memory_rss_bytes ${r.memory?.rss ?? 0}`,
  ];
  const metric = (name, help) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
  };
  metric('al_bot_pipeline_queue_depth', 'Pending events per queue');
  for (const q of queues) lines.push(`al_bot_pipeline_queue_depth{queue="${promLabelSafe(q)}"} ${p.queueDepth?.[q] ?? 0}`);
  metric('al_bot_pipeline_queue_wait_p95_ms', 'p95 enqueue-to-send latency per queue (rolling window)');
  for (const q of queues) lines.push(`al_bot_pipeline_queue_wait_p95_ms{queue="${promLabelSafe(q)}"} ${p.queueWaitP95Ms?.[q] ?? 0}`);
  for (const [name, key, help] of [
    ['al_bot_pipeline_sent_total', 'sent', 'Events sent per queue'],
    ['al_bot_pipeline_failed_total', 'failed', 'Events failed per queue'],
    ['al_bot_pipeline_skipped_total', 'skipped', 'Events skipped (debounce/suppress) per queue'],
    ['al_bot_pipeline_dropped_total', 'dropped', 'Events dropped on overflow per queue'],
    ['al_bot_pipeline_retried_total', 'retried', 'Retry attempts per queue'],
  ]) {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
    for (const q of queues) lines.push(`${name}{queue="${promLabelSafe(q)}"} ${p[key]?.[q] ?? 0}`);
  }
  res.writeHead(200, {'Content-Type':'text/plain; version=0.0.4; charset=utf-8'});
  res.end(lines.join('\n') + '\n');
}

const HANDLERS = {
  async getStatus() {
    const s = readState();
    const health = readJsonSafe(join(__dirname,'health-state.json'));
    const lock = readJsonSafe(join(__dirname,'.bot.lock'));
    // Try to include pipeline metrics if full mode
    const pipelineMetrics = health?.pipeline || null;
    // Also try to read control-plane for channel config
    let controlPlane = null;
    try { controlPlane = readJsonSafe(join(__dirname,'control-plane.json')); } catch {}
    return {
      state: s,
      gateway: {
        lockPresent: !!lock,
        pid: lock?.pid ?? s?.pid ?? null,
        mode: lock?.mode ?? s?.runtime ?? null,
        startedAt: lock?.startedAt ?? null,
        websocket: health?.runtime?.gatewayState ?? null,
        uptimeSec: health?.runtime?.uptimeSec ?? null,
        memory: health?.runtime?.memory ?? null,
        healthAgeSec: fileAgeSec(join(__dirname,'health-state.json')),
      },
      pipeline: pipelineMetrics,
      controlPlane: controlPlane ? { schemaVersion: controlPlane.schemaVersion, channels: controlPlane.logging?.channels, autorole: controlPlane.autorole } : null,
    };
  },
  async diagnose() {
    const st = await HANDLERS.getStatus();
    const g = st.gateway;
    const hasControlPlane = !!st.controlPlane;
    return { checks: [
      `gateway lock: ${g.lockPresent ? `present (pid ${g.pid}, mode ${g.mode})` : 'absent'}`,
      `websocket: ${g.websocket ?? 'unknown'}${g.healthAgeSec !== null ? ` (snapshot age ${g.healthAgeSec}s)` : ''}`,
      `mode: ${hasControlPlane ? 'full (logging+autorole) - control-plane.json present' : 'minimal (presence only) - no control-plane.json'}`,
      `pipeline: ${st.pipeline ? `active ${JSON.stringify(st.pipeline.queueDepth)}` : 'not active (minimal mode or gateway starting)'}`,
      'single-instance enforcement: active (.bot.lock)',
      'hmac + post-auth rate limit: enforced',
      `control-plane: ${hasControlPlane ? 'loaded' : 'not found (copy control-plane.example.json to enable full mode)'}`,
    ] };
  },
  async readLogs(params) {
    const n = Math.min(Number(params?.lines)||20, 100);
    let sup=''; let adp='';
    try{ sup = readFileSync(join(__dirname,'supervisor.log'),'utf8').split('\n').slice(-n).join('\n'); }catch{}
    try{ adp = readFileSync(LOG_FILE,'utf8').split('\n').slice(-n).join('\n'); }catch{}
    return { supervisorTail: sup, adapterTail: adp };
  },
  async suggestConfig(params) {
    // Validate params as partial control-plane update and show diff vs current file
    let current = null;
    try { current = readJsonSafe(join(__dirname,'control-plane.json')); } catch {}
    if (!current) {
      return { validated: true, suggestion: params, diff: 'no existing control-plane.json - would create new file', note: 'use stageConfig to stage' };
    }
    const merged = mergePartialUpdate(current, params);
    const changes = diffConfigs(current, merged);
    return { validated:true, suggestion: params, changes, note:'use stageConfig to stage and then config-manager apply to validate/resource-check/health-check' };
  },
  async stageConfig(params) {
    // Staged write with validation already done via validateParams; also verify against full schema if possible
    const stagedPath = join(__dirname,'control-plane.staged.json');
    // Merge with existing via the shared mergePartialUpdate; a partial update
    // without a base produces an invalid staged file that would only fail
    // later at apply time — reject with the actionable fix instead.
    const base = readJsonSafe(join(__dirname,'control-plane.json'));
    if (!base) {
      throw new Error('no existing control-plane.json to merge partial update with — create it from control-plane.example.json first');
    }
    const toStage = mergePartialUpdate(base, params);
    const changes = diffConfigs(base, toStage);
    atomicWriteJson(stagedPath, toStage);
    return { applied:false, staged:true, path:'control-plane.staged.json', changes, stagedData: toStage, note:'staged - run "node config-manager.mjs apply --source=adapter" to validate/diff/resource-check/health-check and atomically apply' };
  },
  async listChannels() {
    const token = readEnv('DISCORD_TOKEN');
    const guildId = readGuildId();
    if (!token || !guildId) {
      return { error:'full mode not configured — DISCORD_TOKEN and GUILD_ID required', channels: [] };
    }
    try {
      const channels = await getGuildChannels(guildId, token);
      const filtered = channels.map(c=>({id:c.id, name:c.name, type:c.type, parentId:c.parent_id})).slice(0,100);
      return { guildId, channels: filtered, total: channels.length };
    } catch(e){
      return { error: e.message, channels: [] };
    }
  },
};

async function handleAction(action, params){
  const handler = HANDLERS[action];
  if (!handler) throw new Error('unhandled');
  return handler(params);
}

if (SOCKET_PATH) {
  try { unlinkSync(SOCKET_PATH); } catch {}
  server.listen(SOCKET_PATH, ()=>{
    try { chmodSync(SOCKET_PATH, 0o600); } catch {}
    log(`listening on unix socket ${SOCKET_PATH} (mode 0600) - allowlist: ${[...ALLOWLIST].join(', ')} - hmac enforced, maxBody ${MAX_BODY}`);
  });
} else {
  server.listen(PORT, '127.0.0.1', ()=>{
    log(`listening on 127.0.0.1:${PORT} - allowlist: ${[...ALLOWLIST].join(', ')} - hmac enforced, maxBody ${MAX_BODY}`);
  });
}
function shutdown(signal){
  log(`${signal} - closing`);
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(0), 3000).unref();
}
process.on('SIGTERM', ()=>shutdown('SIGTERM'));
process.on('SIGINT', ()=>shutdown('SIGINT'));
