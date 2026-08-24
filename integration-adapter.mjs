#!/usr/bin/env node
// integration-adapter.mjs — hardened local HTTP API (HMAC, persistent dedupe,
// schema, post-auth rate limit, body limit). Secrets load through lib/env
// (dotenv), handlers live in a registry, staged writes use the shared atomic
// helper. v2 scope: getStatus / diagnose / readLogs only — the control-plane
// config actions were removed with the logging system.
import { createServer } from 'node:http';
import { readFileSync, appendFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { startRotationWatcher } from './log-rotation.mjs';
import { readEnv } from './lib/env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// rotation watcher for adapter logs (async, light) — health-state is owned by gateway only
try {
  const _rotLogs = [join(__dirname, 'adapter.log'), join(__dirname, 'adapter-seen.jsonl')];
  startRotationWatcher(_rotLogs);
} catch {}
const PORT = 3415;
const STATE_FILE = join(__dirname, 'bot-state.json');
const LOG_FILE = join(__dirname, 'adapter.log');
const SEEN_FILE = join(__dirname, 'adapter-seen.jsonl'); // persistent requestId + nonce
const MAX_BODY = 64 * 1024; // 64KB
const HMAC_WINDOW_MS = 5 * 60 * 1000; // 5 min
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 60; // per IP per minute

// Load secret from .env via lib/env (dotenv) — clear error, no regex parsing
const ADAPTER_TOKEN = readEnv('ADAPTER_TOKEN');
if (!ADAPTER_TOKEN) {
  console.error('FATAL: ADAPTER_TOKEN not found. Copy .env.example to .env and generate a token with:');
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

const ALLOWLIST = new Set(['getStatus', 'diagnose', 'readLogs']);
const BLOCKED = new Set(['execOS','runShell','changeToken','updateSecrets','modifyConfig','startGateway','stopGateway']);

// Schemas per action
const SCHEMAS = {
  getStatus: { params: 'empty' },
  diagnose: { params: 'empty' },
  readLogs: { params: 'readLogs' },
};

function validateParams(action, params) {
  const schema = SCHEMAS[action];
  if (!schema) return 'unknown action';
  if (schema.params === 'empty') {
    if (params && Object.keys(params).length) return 'params must be empty';
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
  return null;
}

// Persistent seen sets (loaded from file)
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

// Rate limiters: ip -> timestamps[]
//  - rateMap: AUTHENTICATED requests only — enforced AFTER successful auth so
//    an unauthenticated local process can no longer exhaust the budget of the
//    legitimate caller (all localhost clients share one IP).
//  - authFailMap: failed authentications only — keeps the brute-force guard
//    without touching the authenticated bucket.
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

// Auth-phase rejection: records the failure into its own brute-force bucket;
// once that bucket is exhausted the caller gets 429 instead of the real code.
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
  // body size limit
  let body=''; let tooLarge=false;
  req.on('data',c=>{
    if(tooLarge) return; // stop accumulating; socket destroyed below
    body+=c;
    if(body.length > MAX_BODY){
      tooLarge=true;
      try{ req.destroy(); }catch{} // abort stream immediately — no unbounded memory
    }
  });
  req.on('end', async ()=>{
    if(tooLarge){
      res.writeHead(413,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'body_too_large',max:MAX_BODY}));
      return;
    }
    const started = Date.now();
    // auth: header token (timing-safe compare)
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
    // HMAC check
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
    // verify HMAC: HMAC-SHA256 of timestamp.nonce.body
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

    // AUTHENTICATED — now (and only now) the per-IP request budget applies.
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

    // requestId dedupe — persistent (file-backed) for every action
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
      // slice: never dump long internal output/stack to caller
      const msg = String(e?.message||'error').slice(0,200);
      res.writeHead(code,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:msg,requestId:rid}));
    }
  });
});

// Action handler registry — adding an action means adding one entry here plus
// its SCHEMAS entry. handleAction dispatches; the request pipeline stays untouched.
// getStatus reads ONLY local atomic files written by the gateway/supervisor —
// no subprocess spawn, no REST calls, no stale Discord data. The websocket
// state comes from health-state.json (authored by the live gateway itself,
// refreshed every HEALTH_INTERVAL_MS); its age in seconds is included so the
// caller can judge freshness.
function readJsonSafe(path){ try{ return JSON.parse(readFileSync(path,'utf8')); }catch{ return null; } }
function fileAgeSec(path){ try{ return Math.round((Date.now()-statSync(path).mtimeMs)/1000); }catch{ return null; } }

const HANDLERS = {
  async getStatus() {
    const s = readState();
    const health = readJsonSafe(join(__dirname,'health-state.json'));
    const lock = readJsonSafe(join(__dirname,'.bot.lock'));
    return {
      state: s,
      gateway: {
        lockPresent: !!lock,
        pid: lock?.pid ?? s?.pid ?? null,
        mode: lock?.mode ?? s?.runtime ?? null,
        startedAt: lock?.startedAt ?? null,
        // authoritative ws status, written by the gateway process itself
        websocket: health?.runtime?.gatewayState ?? null,
        uptimeSec: health?.runtime?.uptimeSec ?? null,
        memory: health?.runtime?.memory ?? null,
        healthAgeSec: fileAgeSec(join(__dirname,'health-state.json')),
      },
    };
  },
  async diagnose() {
    const st = await HANDLERS.getStatus();
    const g = st.gateway;
    return { checks: [
      `gateway lock: ${g.lockPresent ? `present (pid ${g.pid}, mode ${g.mode})` : 'absent'}`,
      `websocket: ${g.websocket ?? 'unknown'}${g.healthAgeSec !== null ? ` (snapshot age ${g.healthAgeSec}s)` : ''}`,
      'single-instance enforcement: active (.bot.lock)',
      'hmac + post-auth rate limit: enforced',
    ] };
  },
  async readLogs(params) {
    const n = Math.min(Number(params?.lines)||20, 100);
    let sup=''; let adp='';
    try{ sup = readFileSync(join(__dirname,'supervisor.log'),'utf8').split('\n').slice(-n).join('\n'); }catch{}
    try{ adp = readFileSync(LOG_FILE,'utf8').split('\n').slice(-n).join('\n'); }catch{}
    return { supervisorTail: sup, adapterTail: adp };
  },
};

async function handleAction(action, params){
  const handler = HANDLERS[action];
  if (!handler) throw new Error('unhandled');
  return handler(params);
}

server.listen(PORT, '127.0.0.1', ()=>{
  log(`listening on 127.0.0.1:${PORT} — allowlist: ${[...ALLOWLIST].join(', ')} — hmac enforced, maxBody ${MAX_BODY}`);
});
function shutdown(signal){
  log(`${signal} — closing`);
  server.close(()=>process.exit(0));
  // force-exit if close hangs on keep-alive sockets
  setTimeout(()=>process.exit(0), 3000).unref();
}
process.on('SIGTERM', ()=>shutdown('SIGTERM'));
process.on('SIGINT', ()=>shutdown('SIGINT'));
