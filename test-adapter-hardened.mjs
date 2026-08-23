import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';

const env = readFileSync('./.env','utf8');
const token = env.match(/ADAPTER_TOKEN\s*=\s*(.+)/)[1].trim();

function sign(body, ts, nonce) {
  return createHmac('sha256', token).update(`${ts}.${nonce}.${body}`).digest('hex');
}
async function req({action, params, requestId, useHmac=true, badHmac=false, noToken=false, timestamp=Date.now(), nonce=randomUUID()}){
  const body = JSON.stringify({requestId: requestId||`test-${Date.now()}-${Math.random()}`, identity:'owner', action, params, ownerApproval: action==='applyConfig' ? true : undefined});
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
console.log(await req({action:'getStatus', params:{}, noToken:true}));

console.log('\n=== Test 2: missing HMAC headers ===');
console.log(await req({action:'getStatus', params:{}, useHmac:false}));

console.log('\n=== Test 3: wrong HMAC ===');
console.log(await req({action:'getStatus', params:{}, badHmac:true}));

console.log('\n=== Test 4: replay (same nonce) ===');
const nonce = randomUUID();
const ts = Date.now();
const body1 = JSON.stringify({requestId:'replay-test', identity:'owner', action:'diagnose', params:{}});
const sig1 = sign(body1, String(ts), nonce);
const headers1 = {'Content-Type':'application/json','X-Adapter-Token':token,'X-Timestamp':String(ts),'X-Nonce':nonce,'X-Signature':sig1};
let r1 = await fetch('http://127.0.0.1:3415/adapter/request', {method:'POST', headers:headers1, body:body1});
console.log('first', r1.status, await r1.json());
let r2 = await fetch('http://127.0.0.1:3415/adapter/request', {method:'POST', headers:headers1, body:body1});
console.log('replay', r2.status, await r2.json());

console.log('\n=== Test 5: large body >64KB ===');
const largeBody = JSON.stringify({requestId:'large', identity:'owner', action:'suggestConfig', params:{data:'x'.repeat(70000)}});
const ts5=Date.now(), nonce5=randomUUID(), sig5=sign(largeBody, String(ts5), nonce5);
let r5 = await fetch('http://127.0.0.1:3415/adapter/request', {method:'POST', headers:{'Content-Type':'application/json','X-Adapter-Token':token,'X-Timestamp':String(ts5),'X-Nonce':nonce5,'X-Signature':sig5}, body:largeBody});
console.log(r5.status, await r5.text().then(t=>t.slice(0,200)));

console.log('\n=== Test 6: invalid params (applyConfig with blocked key tokenEnv) ===');
console.log(await req({action:'applyConfig', params:{schemaVersion:1, tokenEnv:'evil'}}));

console.log('\n=== Test 7: blocked action ===');
console.log(await req({action:'execOS', params:{}}));

console.log('\n=== Test 8: valid request ===');
console.log(await req({action:'diagnose', params:{}}));

console.log('\n=== Test 9: persistent requestId after restart simulation (check file) ===');
import { readFileSync as rfs, existsSync } from 'node:fs';
if(existsSync('./adapter-seen.jsonl')){
  const lines = rfs('./adapter-seen.jsonl','utf8').split('\n').filter(Boolean);
  console.log('seen file lines', lines.length, 'last', lines.slice(-1)[0]?.slice(0,120));
} else console.log('no seen file');

console.log('\n=== Test 10: rate limit (burst 70) ===');
let rateLimited=0;
for(let i=0;i<70;i++){
  const b = JSON.stringify({requestId:`rate-${i}-${Date.now()}`, identity:'owner', action:'diagnose', params:{}});
  const tsi=Date.now(), n=randomUUID(), s=sign(b, String(tsi), n);
  const r = await fetch('http://127.0.0.1:3415/adapter/request', {method:'POST', headers:{'Content-Type':'application/json','X-Adapter-Token':token,'X-Timestamp':String(tsi),'X-Nonce':n,'X-Signature':s}, body:b});
  if(r.status===429) rateLimited++;
}
console.log('rate limited count (should be >0 after 60):', rateLimited);
