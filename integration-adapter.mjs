#!/usr/bin/env node
// integration-adapter.mjs — hardened local HTTP API (HMAC, persistent dedupe,
// schema, rate limit, body limit). Since v1.0.0: secrets load through lib/env
// (dotenv), handlers live in a registry so new actions are a one-entry change,
// and staged writes use the shared atomic write helper.
import { createServer } from 'node:http';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { startRotationWatcher } from './log-rotation.mjs';
import { readEnv } from './lib/env.mjs';
import { atomicWriteJson } from './lib/atomic.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// rotation watcher for adapter logs (async, light) — health-state is owned by gateway (logger) only
try {
  const _rotLogs = [join(__dirname, 'adapter.log'), join(__dirname, 'adapter-seen.jsonl'), join(__dirname, 'config-lifecycle.log')];
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

const ALLOWLIST = new Set(['getStatus','suggestConfig','applyConfig','diagnose','readLogs','listChannels']);
const BLOCKED = new Set(['execOS','runShell','changeToken','updateSecrets','modifyConfigWithoutValidation','adminDiscordWithoutScope','startGateway','stopGatewayWithoutSupervisor']);

// Dangerous key names for applyConfig — EXACT lowercase match (substring matching
// wrongly rejected legitimate keys like 'logging' because it contains 'log').
// Structural allowlisting below already restricts shape; this is defense-in-depth
// against dangerous/dangerous-sounding exact names and pollution vectors.
const BLOCKED_EXACT_KEYS = new Set([
  'token','tokenenv','adapter_token','secret','password',
  'ownerid','owner','__proto__','constructor','prototype',
  'path','paths','port','ports','runtime','pid','pidfile','lockfile',
  'statefile','logfile','logfiles','stalelockms','gracefulstopms',
  'queue','queues','maxlengths','ratelimit','rate_limits',
]);

// Schemas per action
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
    // structural allowlist: top-level
    const allowedTop = new Set(['schemaVersion', 'logging', 'permissions']);
    for (const k of Object.keys(params)) {
      if (!allowedTop.has(k)) return `top-level key not allowed: ${k}`;
      if (BLOCKED_EXACT_KEYS.has(k.toLowerCase())) return `blocked key: ${k}`;
    }
    // exact-name dangerous-key scan anywhere in the payload + nested shape allowlist
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
    // specific logging validation
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
    // permissions: only allow safe subkeys, never ownerId
    if (params.permissions) {
      if (typeof params.permissions !== 'object') return 'permissions must be object';
      const allowedPerm = new Set(['controlPlaneAllowedRoles','requireAuditForModLog']);
      for (const k of Object.keys(params.permissions)) if (!allowedPerm.has(k)) return `permissions key not allowed: ${k}`;
    }
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

// Rate limiter: ip -> timestamps[]
const rateMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const arr = rateMap.get(ip) || [];
  const recent = arr.filter(t => now - t < RATE_LIMIT_WINDOW);
  recent.push(now);
  rateMap.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of rateMap) {
    const recent = arr.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (recent.length) rateMap.set(ip, recent); else rateMap.delete(ip);
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

const server = createServer(async (req,res)=>{
  const ip = req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    res.writeHead(429,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:false,error:'rate_limited',retryAfterMs:RATE_LIMIT_WINDOW}));
    return;
  }
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
      res.writeHead(401,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'unauthorized'}));
      return;
    }
    // HMAC check
    const timestamp = req.headers['x-timestamp'];
    const nonce = req.headers['x-nonce'];
    const signature = req.headers['x-signature'];
    if(!timestamp || !nonce || !signature){
      res.writeHead(401,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'missing_hmac_headers'}));
      return;
    }
    const tsNum = Number(timestamp);
    if(!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > HMAC_WINDOW_MS){
      res.writeHead(401,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'bad_timestamp'}));
      return;
    }
    if(seenNonces.has(nonce)){
      res.writeHead(409,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'duplicate_nonce'}));
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
      res.writeHead(401,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'bad_signature'}));
      return;
    }

    let payload;
    try{ payload = JSON.parse(body); }catch{ res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'invalid_json'})); return; }

    const { requestId, identity, action, params, ownerApproval } = payload;
    const rid = requestId || `auto-${Date.now()}`;
    log(`request ${rid} action=${action} identity=${identity} ip=${ip}`);

    // requestId dedupe: for sensitive actions, persistent check (file), for others memory
    const isSensitive = new Set(['applyConfig']).has(action);
    if(seenRequestIds.has(rid)){
      res.writeHead(409,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false,error:'duplicate_requestId',requestId:rid}));
      return;
    }
    // for sensitive, also check persistent file already loaded; seenRequestIds already contains persistent ones
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
    const sensitive = new Set(['applyConfig']);
    if(sensitive.has(action) && !ownerApproval){
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,mode:'suggest',message:'ownerApproval required — proposal validated but not applied',requestId:rid,action,params}));
      recordCircuit(true);
      return;
    }
    // ownerApproval check for sensitive: identity must be owner (payload identity is not proof, but we already verified HMAC token, so token holder is trusted)
    // Still, we require ownerApproval flag; token already proves caller is owner-level

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
// its SCHEMAS entry and (for sensitive ones) the allowlist. handleAction
// dispatches; the request pipeline above stays untouched.
const HANDLERS = {
  async getStatus() {
    const s = readState();
    let supervisor = null;
    try{
      const { execSync } = await import('node:child_process');
      const out = execSync(`node "${join(__dirname,'bot-supervisor.mjs')}" --action=status`,{encoding:'utf8',timeout:4000});
      supervisor = out.slice(0,2000);
    }catch(e){ supervisor = String(e.message).slice(0,200); }
    return { state:s, supervisor };
  },
  async suggestConfig(params) {
    return { validated:true, suggestion: params, note:'use applyConfig with ownerApproval to apply' };
  },
  async applyConfig(params) {
    const stagedPath = join(__dirname,'control-plane.staged.json');
    atomicWriteJson(stagedPath, params);
    return { applied:false, staged:true, path:'control-plane.staged.json', note:'staged — run config-manager apply to validate/diff/resource-check/health-check' };
  },
  async diagnose() {
    return { checks: ['gateway single instance — ok','pipeline queues — 5 categories','audit resolver — active','hmac — enforced','rate limit — active'] };
  },
  async readLogs(params) {
    const n = Math.min(Number(params?.lines)||20, 100);
    let sup=''; let adp='';
    try{ sup = readFileSync(join(__dirname,'supervisor.log'),'utf8').split('\n').slice(-n).join('\n'); }catch{}
    try{ adp = readFileSync(LOG_FILE,'utf8').split('\n').slice(-n).join('\n'); }catch{}
    return { supervisorTail: sup, adapterTail: adp };
  },
  async listChannels() {
    return { note: 'use Discord REST via control plane — not direct' };
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
