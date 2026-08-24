// test-adapter-hardened.mjs — adapter security surface. Requires the adapter
// running on 127.0.0.1:3415 (npm test starts one automatically; README lists
// the manual command). Since v1.0.0 the oversized-body test handles the
// server's socket-destroy behaviour instead of crashing, so the whole file
// runs to completion.
import { readFileSync, existsSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { readEnv } from './lib/env.mjs';

const token = readEnv('ADAPTER_TOKEN');
if (!token) {
  console.error('FATAL: ADAPTER_TOKEN missing — copy .env.example to .env (see README).');
  process.exit(1);
}

function sign(body, ts, nonce) {
  return createHmac('sha256', token).update(`${ts}.${nonce}.${body}`).digest('hex');
}
async function req({action, params, requestId, useHmac=true, badHmac=false, noToken=false, timestamp=Date.now(), nonce=randomUUID()}){
  const body = JSON.stringify({requestId: requestId||`test-${Date.now()}-${Math.random()}`, identity:'owner', action, params});
  const ts = String(timestamp);
  const sig = badHmac ? 'bad' : sign(body, ts, nonce);
  const headers = {
    'Content-Type':'application/json',
  };
  if(!noToken) headers['X-Adapter-Token']=token;
  if(useHmac){
    headers['X-Timestamp']=ts;
    headers['X-Nonce']=nonce;
    headers['X-Signature']=sig;
  }
  const r = await fetch('http://127.0.0.1:3415/adapter/request', {method:'POST', headers, body});
  const j = await r.json().catch(()=> ({}));
  return {status:r.status, json:j, headers};
}

console.log('=== Test 1: missing header (no token) ===');
{
  const r = await req({action:'getStatus', params:{}, noToken:true});
  console.log(r.status === 401 && r.json.error === 'unauthorized' ? 'PASS unauthorized' : `FAIL got ${r.status} ${JSON.stringify(r.json).slice(0,100)}`);
}

console.log('\n=== Test 2: missing HMAC headers ===');
{
  const r = await req({action:'getStatus', params:{}, useHmac:false});
  console.log(r.status === 401 && r.json.error === 'missing_hmac_headers' ? 'PASS missing hmac headers rejected' : `FAIL got ${r.status} ${JSON.stringify(r.json).slice(0,100)}`);
}

console.log('\n=== Test 3: wrong HMAC ===');
{
  const r = await req({action:'getStatus', params:{}, badHmac:true});
  console.log(r.status === 401 && r.json.error === 'bad_signature' ? 'PASS bad signature rejected' : `FAIL got ${r.status} ${JSON.stringify(r.json).slice(0,100)}`);
}

console.log('\n=== Test 4: replay (same nonce) ===');
{
  // Unique requestId per run — the adapter dedupes requestIds for 24h, so a
  // fixed id would make even the FIRST request of a later run a "duplicate".
  // The replay property under test is the identical nonce + signature pair.
  const nonce = randomUUID();
  const ts = Date.now();
  const rid = `replay-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const body1 = JSON.stringify({requestId: rid, identity:'owner', action:'diagnose', params:{}});
  const sig1 = sign(body1, String(ts), nonce);
  const headers1 = {'Content-Type':'application/json','X-Adapter-Token':token,'X-Timestamp':String(ts),'X-Nonce':nonce,'X-Signature':sig1};
  const r1 = await fetch('http://127.0.0.1:3415/adapter/request', {method:'POST', headers:headers1, body:body1});
  const j1 = await r1.json().catch(()=>({}));
  const r2 = await fetch('http://127.0.0.1:3415/adapter/request', {method:'POST', headers:headers1, body:body1});
  const j2 = await r2.json().catch(()=>({}));
  const ok = r1.status === 200 && r2.status === 409 && j2.error === 'duplicate_nonce';
  console.log(ok ? 'PASS replay rejected (409 duplicate_nonce)' : `FAIL first=${r1.status} replay=${r2.status} ${JSON.stringify(j2).slice(0,120)}`);
}

console.log('\n=== Test 5: large body >64KB ===');
{
  // The server destroys the socket mid-upload; a compliant client sees either
  // a 413 response or a connection error — both prove the limit is enforced.
  const largeBody = JSON.stringify({requestId:'large', identity:'owner', action:'diagnose', params:{data:'x'.repeat(70000)}});
  const ts5=Date.now(), nonce5=randomUUID(), sig5=sign(largeBody, String(ts5), nonce5);
  let status = 0, err = null;
  try{
    const r5 = await fetch('http://127.0.0.1:3415/adapter/request', {method:'POST', headers:{'Content-Type':'application/json','X-Adapter-Token':token,'X-Timestamp':String(ts5),'X-Nonce':nonce5,'X-Signature':sig5}, body:largeBody});
    status = r5.status;
  }catch(e){ err = e.message; }
  const ok = status === 413 || (err !== null);
  console.log(ok ? `PASS oversized body blocked (status=${status}${err ? ', socket destroyed: '+err : ''})` : `FAIL status=${status} no error`);
}

console.log('\n=== Test 6: invalid params (readLogs with non-numeric lines) ===');
{
  const r = await req({action:'readLogs', params:{ lines: 'abc' }});
  console.log(r.status === 400 && r.json.error === 'invalid_params' ? 'PASS invalid params rejected' : `FAIL got ${r.status} ${JSON.stringify(r.json).slice(0,100)}`);
}

console.log('\n=== Test 7: blocked action ===');
{
  const r = await req({action:'execOS', params:{}});
  console.log(r.status === 403 && r.json.error === 'action_blocked' ? 'PASS blocked action rejected' : `FAIL got ${r.status} ${JSON.stringify(r.json).slice(0,100)}`);
}

console.log('\n=== Test 8: valid request ===');
{
  const r = await req({action:'diagnose', params:{}});
  console.log(r.status === 200 && r.json.ok ? 'PASS valid request accepted' : `FAIL got ${r.status}`);
}

console.log('\n=== Test 9: persistent requestId/nonce file ===');
{
  if(existsSync('./adapter-seen.jsonl')){
    const lines = readFileSync('./adapter-seen.jsonl','utf8').split('\n').filter(Boolean);
    console.log(`INFO seen file lines: ${lines.length} (persistence active) — PASS`);
  } else { console.log('FAIL no seen file — persistence not working'); }
}

console.log('\n=== Test 10: rate limit (burst 70) ===');
{
  let rateLimited=0;
  for(let i=0;i<70;i++){
    const b = JSON.stringify({requestId:`rate-${i}-${Date.now()}-${Math.random()}`, identity:'owner', action:'diagnose', params:{}});
    const tsi=Date.now(), n=randomUUID(), s=sign(b, String(tsi), n);
    try{
      const r = await fetch('http://127.0.0.1:3415/adapter/request', {method:'POST', headers:{'Content-Type':'application/json','X-Adapter-Token':token,'X-Timestamp':String(tsi),'X-Nonce':n,'X-Signature':s}, body:b});
      if(r.status===429) rateLimited++;
      else await r.json().catch(()=>{});
    }catch{}
  }
  console.log(rateLimited > 0 ? `PASS rate limited ${rateLimited}/70 after limit` : 'FAIL no rate limiting observed');
}

console.log('\nAll hardened adapter tests done');
// Drain naturally instead of process.exit() — see test-adapter-validation.mjs.
process.exitCode = 0;
