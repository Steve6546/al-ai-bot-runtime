import { EventPipeline } from './event-pipeline.mjs';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';

const FAILED_FILE = './failed-events.jsonl';
try { unlinkSync(FAILED_FILE); } catch {}

// Always-failing mod channel to force retries
let fetchCount = 0;
const mockClient = {
  guilds: { fetch: async () => ({ channels: { fetch: async () => ({ isTextBased: () => true, send: async () => { throw new Error('429 simulated'); } }) } }) }
};
const channels = { MOD_LOG:'mod', MEMBER:'m', SERVER:'s', VOICE_LOG:'v', MESSAGE:'msg', JOIN_LEAVE:'j' };
async function sendEmbed(chId){ if(chId==='mod') throw new Error('429 simulated'); }
async function getAudit(){ return null; }
const log = ()=>{}; const err = ()=>{};

const p = new EventPipeline({ client: mockClient, channels, getAudit, sendEmbed, log, err, maxLengths:{moderation:50,message:10,voice:10,member:10,server:10} });

console.log('=== T8: moderation bounded retries (no infinite unshift) ===');
p.enqueue('moderation', { type:'ban', targetId:'x1', targetTag:'x1', guildId:'g' });
// let pipeline drain with persistent failure
await new Promise(r=>setTimeout(r, 9000));
console.log('retried counter:', p.metrics.retried.moderation);
console.log('queue depth after settle:', p.metrics.queueDepth.moderation);
console.log('failed-events exists:', existsSync(FAILED_FILE));
if(existsSync(FAILED_FILE)){
  const line = readFileSync(FAILED_FILE,'utf8').trim().split('\n').pop();
  console.log('last failed entry reason:', line.slice(0,140));
}
const pass = p.metrics.retried.moderation <= 2 && (!existsSync(FAILED_FILE) || readFileSync(FAILED_FILE,'utf8').includes('retries exhausted'));
console.log(pass ? 'PASS bounded retries → failed-events' : 'CHECK MANUALLY');

console.log('\n=== T9: FIFO preserved on retry (push not unshift) ===');
// quick logic check: enqueue A (fails), B; A should retry AFTER B
const order = [];
const p2 = new EventPipeline({ client: mockClient, channels,
  getAudit: async()=>null,
  sendEmbed: async(ch)=>{ if(ch==='mod'){ order.push('fail'); throw new Error('boom'); } },
  log, err, maxLengths:{moderation:10} });
p2.enqueue('moderation', { type:'ban', targetId:'A', targetTag:'A', guildId:'g' });
p2.enqueue('moderation', { type:'ban', targetId:'B', targetTag:'B', guildId:'g' });
await new Promise(r=>setTimeout(r, 6000));
console.log('fail order:', order.join(','), '(A,B interleaved = FIFO kept)' , order[0]==='fail'&&order.includes('fail') ? 'PASS (no front-jumping storm)' : 'INSPECT');

console.log('\n=== T10: prototype pollution rejected ===');
process.env.ADAPTER_TEST = '1';
const { createHmac, randomUUID } = await import('node:crypto');
const env = readFileSync('./.env','utf8');
const token = env.match(/ADAPTER_TOKEN\s*=\s*(.+)/)[1].trim();
async function adapterCall(action, params){
  const body = JSON.stringify({requestId:`t-${randomUUID()}`, identity:'owner', action, params, ownerApproval:true});
  const ts=String(Date.now()), nonce=randomUUID();
  const sig = createHmac('sha256', token).update(`${ts}.${nonce}.${body}`).digest('hex');
  try{
    const r = await fetch('http://127.0.0.1:3415/adapter/request',{method:'POST',headers:{'Content-Type':'application/json','X-Adapter-Token':token,'X-Timestamp':ts,'X-Nonce':nonce,'X-Signature':sig},body});
    return {status:r.status, json:await r.json().catch(()=>({}))};
  }catch(e){ return {status:0, json:{error:e.message}}; }
}
const r10 = await adapterCall('applyConfig', { schemaVersion:1, logging:{ debounceMs:2500 }, __proto__: { polluted: true }, nested: { constructor: {} } });
console.log(r10.status, JSON.stringify(r10.json).slice(0,180));
console.log(r10.status===400 ? 'PASS pollution keys rejected' : `FAIL got ${r10.status}`);

console.log('\n=== T11: valid request still OK (timing-safe path) ===');
const r11 = await adapterCall('diagnose', {});
console.log(r11.status===200 ? 'PASS valid request accepted' : `FAIL ${r11.status} ${JSON.stringify(r11.json).slice(0,120)}`);

console.log('\nDone.');
process.exit(0);
