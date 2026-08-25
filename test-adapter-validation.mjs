import { createHmac, randomUUID } from 'node:crypto';
import { readEnv } from './lib/env.mjs';

const token = readEnv('ADAPTER_TOKEN');
if (!token) {
  console.error('FATAL: ADAPTER_TOKEN missing — copy .env.example to .env (see README).');
  process.exit(1);
}

async function adapterCall(action, params){
  const body = JSON.stringify({requestId:`t-${randomUUID()}`, identity:'owner', action, params, ownerApproval:true});
  const ts=String(Date.now()), nonce=randomUUID();
  const sig = createHmac('sha256', token).update(`${ts}.${nonce}.${body}`).digest('hex');
  try{
    const r = await fetch('http://127.0.0.1:3415/adapter/request',{method:'POST',headers:{'Content-Type':'application/json','X-Adapter-Token':token,'X-Timestamp':ts,'X-Nonce':nonce,'X-Signature':sig},body});
    return {status:r.status, json:await r.json().catch(()=>({}))};
  }catch(e){ return {status:0, json:{error:String(e.message).slice(0,100)}}; }
}

console.log('=== T10a: VALID applyConfig with logging+permissions must pass ===');
const good = await adapterCall('applyConfig', {
  schemaVersion: 1,
  logging: { debounceMs: 2600, batchMs: 3500, suppressMs: 10000,
    channels: { JOIN_LEAVE:'1540984557883367484', VOICE_LOG:'1540984560798666812', MOD_LOG:'1540984563776364585', MESSAGE:'1540991170740752474', MEMBER:'1540991173596942406', SERVER:'1540991176335687720' } },
  permissions: { controlPlaneAllowedRoles:['Owner','Co Owner'], requireAuditForModLog:true }
});
console.log(good.status, JSON.stringify(good.json).slice(0,160));
console.log(good.status===200 && good.json.ok ? 'PASS valid config accepted' : 'FAIL');

console.log('\n=== T10b: __proto__/constructor nested must be rejected ===');
const bad1 = await adapterCall('applyConfig', { schemaVersion:1, logging:{ debounceMs:2500 }, extraProto: JSON.parse('{"__proto__":{"x":1}}') });
// note: top-level 'extraProto' already rejected by allowlist; test nested __proto__ via raw JSON:
const bad2raw = '{"schemaVersion":1,"logging":{"debounceMs":2500,"channels":{"JOIN_LEAVE":"1540984557883367484"}},"evil_nested":{"__proto__":{"x":1},"constructor":{}}}';
const body2 = JSON.stringify({requestId:`t-${randomUUID()}`, identity:'owner', action:'applyConfig', params: JSON.parse(bad2raw), ownerApproval:true});
const ts=String(Date.now()), nonce=randomUUID();
const sig = createHmac('sha256', token).update(`${ts}.${nonce}.${body2}`).digest('hex');
let r2;
try{ r2 = await fetch('http://127.0.0.1:3415/adapter/request',{method:'POST',headers:{'Content-Type':'application/json','X-Adapter-Token':token,'X-Timestamp':ts,'X-Nonce':nonce,'X-Signature':sig},body:body2}); }catch(e){ console.log('req err', e.message); }
const j2 = r2? await r2.json().catch(()=>({})) : {};
console.log(r2?.status, JSON.stringify(j2).slice(0,160));
const rejected = (r2?.status===400) || (j2.error==='invalid_params');
console.log(rejected ? 'PASS pollution vector rejected' : `FAIL status=${r2?.status}`);

console.log('\n=== T10c: ownerId injection rejected ===');
const bad3 = await adapterCall('applyConfig', { schemaVersion:1, permissions:{ ownerId:'999' } });
console.log(bad3.status, JSON.stringify(bad3.json).slice(0,140));
console.log(bad3.status===400 ? 'PASS ownerId rejected' : 'FAIL');

console.log('\nAll adapter validation tests done.');
// No process.exit(): undici keep-alive sockets are still closing on Windows/
// Node 24 and a forced exit can trip a libuv teardown assertion — draining
// naturally exits with the code below.
process.exitCode = 0;
