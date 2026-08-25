#!/usr/bin/env node
// integration-adapter.mjs � hardened local HTTP API (HMAC, persistent dedupe,
// schema, post-auth rate limit, body limit). Hybrid v2+v1: retains v2 security
// (post-auth rate limiting, HMAC, persistent dedupe) and re-adds control-plane
// actions (suggestConfig, applyConfig, listChannels) with strict validation.
import { createServer } from 'node:http';
import { readFileSync, appendFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { startRotationWatcher } from './log-rotation.mjs';
import { readEnv, readGuildId } from './lib/env.mjs';
import { atomicWriteJson } from './lib/atomic.mjs';
import { getGuildChannels } from './lib/discord.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const _rotLogs = [join(__dirname, 'adapter.log'), join(__dirname, 'adapter-seen.jsonl')];
  startRotationWatcher(_rotLogs);
} catch {}
const PORT = 3415;
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

const ALLOWLIST = new Set(['getStatus','suggestConfig','applyConfig','diagnose','readLogs','listChannels']);
const BLOCKED = new Set(['execOS','runShell','changeToken','updateSecrets','modifyConfig','startGateway','stopGateway','modifyConfigWithoutValidation','adminDiscordWithoutScope','startGateway','stopGatewayWithoutSupervisor']);

// Dangerous key names for applyConfig � EXACT lowercase match
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
  applyConfig: { params: 'applyConfig' },
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
  if (schema.params === 'applyConfig') {
    if (!params || typeof params !== 'object') return 'params must be object';
    if (typeof params.schemaVersion !== 'number') return 'missing schemaVersion number';
    const allowedTop = new Set(['schemaVersion', 'logging', 'permissions', 'autorole']);
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
    if (params.logging) {
      if (typeof params.logging !== 'object') return 'logging must be object';
      const allowedLogging = new Set(['debounceMs','batchMs','suppressMs','channels']);
      for (const k of Object.keys(params.logging)) if (!allowedLogging.has(k)) return `logging key not allowed: ${k}`;
      if (params.logging.debounceMs !== undefined && (typeof params.logging.debounceMs !== 'number' || params.logging.debounceMs < 500 || params.logging.debounceMs > 10000)) return 'debounceMs 500-10000';
      if (params.logging.batchMs !== undefined && (typeof params.logging.batchMs !== 'number' || params.logging.batchMs < 500 || params.logging.batchMs > 20000)) return 'batchMs 500-20000';
      if (params.logging.suppressMs !== undefined && (typeof params.logging.suppressMs !== 'number' || params.logging.suppressMs < 1000 || params.logging.suppressMs > 30000)) return 'suppressMs 1000-30000';
      if (params.logging.channels) {
        if (typeof params.logging.channels !== 'object') return 'channels must be object';
        for (const [ck,cv] of Object.entries(params.logging.channels)) {
          if (!/^\d{17,20}$/.test(String(cv))) return `channel ${ck} must be snowflake`;
        }
      }
    }
    if (params.permissions) {
      if (typeof params.permissions !== 'object') return 'permissions must be object';
      const allowedPerm = new Set(['controlPlaneAllowedRoles','requireAuditForModLog']);
      for (const k of Object.keys(params.permissions)) if (!allowedPerm.has(k)) return `permissions key not allowed: ${k}`;
    }
    if (params.autorole) {
      if (typeof params.autorole !== 'object') return 'autorole must be object';
      const allowedAuto = new Set(['enabled','memberRoleName']);
      for (const k of Object.keys(params.autorole)) if (!allowedAuto.has(k)) return `autorole key not allowed: ${k}`;
      if (params.autorole.enabled !== undefined && typeof params.autorole.enabled !== 'boolean') return 'autorole.enabled must be boolean';
      if (params.autorole.memberRoleName !== undefined && (typeof params.autorole.memberRoleName !== 'string' || !params.autorole.memberRoleName.trim())) return 'autorole.memberRoleName must be non-empty string';
    }
    return null;
  }
  return null;
}

const seenRequestIds = new Set();
const seenNonces = new Set();
function loadSeen() {
  try {
    if (!existsSync(SEEN_FILE)) return;
    const lines = readFileSync(SEEN_FILE,'utf8').split('\n').filter(Boolean);
    const now = Date.now();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.requestId && now - new Date(obj.ts).getTime() < 24*3600*1000) seenRequestIds.add(obj.requestId);
        if (obj.nonce && now - new Date(obj.ts).getTime() < 10*60*1000) seenNonces.add(obj.nonce);
      } catch {}
    }
  } catch {}
}
loadSeen();
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

let circuit = { failures:0, openUntil:0 };
function isCircuitOpen(){ return Date.now() < circuit.openUntil; }
function recordCircuit(ok){ if(ok){ circuit.failures=0; return; } circuit.failures++; if(circuit.failures>=3) circuit.openUntil = Date.now()+15000; }

function log(line){
  const l = `${new Date().toISOString()} [adapter] ${line}`;
  console.log(l);
  try{ appendFileSync(LOG_FILE, l+'\n'); }catch{}
}
function readState(){ try{ return JSON.parse(readFileSync(STATE_FILE,'utf8')); }catch{ return {runtime:null,pid:null}; } }

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
  if(req.method!=='POST' || req.url!=='/adapter/request'){
    res.writeHead(404,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:false,error:'not_found'}));
    return;
  }
  let body=''; let tooLarge=false;
  req.on('data',c=>{
    if(tooLarge) return;
    body+=c;
    if(body.length > MAX_BODY){
      tooLarge=true;
      try{ req.destroy(); }catch{}
    }
  });
  req.on('end', async ()=>{
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
    seenRequestIds.add(rid);
    seenNonces.add(nonce);
    persistSeen({ requestId: rid, nonce });

    if(isCircuitOpen()){
      res.writeHead(503,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'circuit_open',retryAfterMs: circuit.openUntil-Date.now()}));
      return;
    }
    if(BLOCKED.has(action)){
      res.writeHead(403,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'action_blocked',action}));
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

function readJsonSafe(path){ try{ return JSON.parse(readFileSync(path,'utf8')); }catch{ return null; } }
function fileAgeSec(path){ try{ return Math.round((Date.now()-statSync(path).mtimeMs)/1000); }catch{ return null; } }

const HANDLERS = {
  async getStatus() {
    const s = readState();
    const health = readJsonSafe(join(__dirname,'health-state.json'));
    const lock = readJsonSafe(join(__dirname,'.bot.lock'));
    // Try to include pipeline metrics if full mode
    let pipelineMetrics = health?.pipeline || null;
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
      `mode: ${hasControlPlane ? 'full (logging+autorole) � control-plane.json present' : 'minimal (presence only) � no control-plane.json'}`,
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
      return { validated: true, suggestion: params, diff: 'no existing control-plane.json � would create new file', note: 'use applyConfig to stage' };
    }
    const changes = [];
    function diff(o,n,path=''){
      const keys=new Set([...Object.keys(o||{}), ...Object.keys(n||{})]);
      for(const k of keys){
        const p=path?path+'.'+k:k;
        const ov=o?.[k], nv=n?.[k];
        if(JSON.stringify(ov)!==JSON.stringify(nv)){
          if(ov && nv && typeof ov==='object' && typeof nv==='object' && !Array.isArray(ov)){
            diff(ov,nv,p);
          } else changes.push({path:p, from:ov, to:nv});
        }
      }
    }
    // For suggest, params is partial; merge into current for diff preview
    const merged = JSON.parse(JSON.stringify(current));
    // shallow merge top-level keys from params
    for(const [k,v] of Object.entries(params)){
      if(v && typeof v==='object' && !Array.isArray(v) && merged[k] && typeof merged[k]==='object'){
        Object.assign(merged[k], v);
        if(v.channels) Object.assign(merged[k], {channels: {...(merged[k].channels||{}), ...v.channels}});
      } else merged[k]=v;
    }
    diff(current, merged);
    return { validated:true, suggestion: params, changes, note:'use applyConfig to stage and then config-manager apply to validate/resource-check/health-check' };
  },
  async applyConfig(params) {
    // Staged write with validation already done via validateParams; also verify against full schema if possible
    const stagedPath = join(__dirname,'control-plane.staged.json');
    // Merge with existing if exists to keep gateway/supervisor/permissions when only logging/autorole updated
    let base = readJsonSafe(join(__dirname,'control-plane.json'));
    let toStage = params;
    if (base && params.schemaVersion && base.schemaVersion) {
      // If params is partial (only logging/autorole), merge to produce full file for staging
      const isPartial = !params.gateway && !params.supervisor;
      if (isPartial) {
        toStage = JSON.parse(JSON.stringify(base));
        if (params.logging) {
          toStage.logging = { ...toStage.logging, ...params.logging };
          if (params.logging.channels) toStage.logging.channels = { ...toStage.logging.channels, ...params.logging.channels };
        }
        if (params.permissions) toStage.permissions = { ...toStage.permissions, ...params.permissions };
        if (params.autorole) toStage.autorole = { ...toStage.autorole, ...params.autorole };
        if (params.schemaVersion) toStage.schemaVersion = params.schemaVersion;
      }
    }
    atomicWriteJson(stagedPath, toStage);
    return { applied:false, staged:true, path:'control-plane.staged.json', stagedData: toStage, note:'staged � run "node config-manager.mjs apply --source=adapter" to validate/diff/resource-check/health-check and atomically apply' };
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

server.listen(PORT, '127.0.0.1', ()=>{
  log(`listening on 127.0.0.1:${PORT} � allowlist: ${[...ALLOWLIST].join(', ')} � hmac enforced, maxBody ${MAX_BODY}`);
});
function shutdown(signal){
  log(`${signal} � closing`);
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(0), 3000).unref();
}
process.on('SIGTERM', ()=>shutdown('SIGTERM'));
process.on('SIGINT', ()=>shutdown('SIGINT'));
