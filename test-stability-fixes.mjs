// test-stability-fixes.mjs — bounded retries and FIFO guarantees.
// T8a/T8b/T9 exercise the REAL failure paths introduced in v1.0.0:
//   T8a: batched moderation flush (flushMod) retries at most twice with
//        backoff, then persists to failed-events.jsonl — never drops.
//   T8b: process()-level moderation retry (guild fetch failure).
//   T9:  FIFO order is preserved when a batch is retried and exhausted.
// T10/T11 are adapter checks and require the adapter running (npm test
// starts one automatically).
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { EventPipeline } from './event-pipeline.mjs';
import { readEnv } from './lib/env.mjs';

const FAILED_FILE = './failed-events.jsonl';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function failedEntries() {
  if (!existsSync(FAILED_FILE)) return [];
  return readFileSync(FAILED_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// ——— T8a: flushMod bounded retry with backoff, then persistence ———
{
  unlinkSync(FAILED_FILE);
  let sendAttempts = 0;
  const mockClient = {
    guilds: { fetch: async () => ({ channels: { fetch: async () => ({ isTextBased: () => true, send: async () => { sendAttempts++; throw new Error('429 simulated'); } }) } }) }
  };
  const channels = { MOD_LOG:'mod', MEMBER:'m', SERVER:'s', VOICE_LOG:'v', MESSAGE:'msg', JOIN_LEAVE:'j' };
  const p = new EventPipeline({
    client: mockClient, channels,
    getAudit: async () => null,
    sendEmbed: async () => {},
    log: () => {}, err: () => {},
    maxLengths: { moderation: 50, message: 10, voice: 10, member: 10, server: 10 },
    timing: { batchMs: 300, debounceMs: 100, suppressMs: 1000 },
  });
  p.enqueue('moderation', { type: 'ban', targetId: 'x1', targetTag: 'x1', thumb: null, guildId: 'g' });
  // batch(300ms) -> fail -> retry1(+1500ms) -> fail -> retry2(+3000ms) -> fail -> persist
  await sleep(6500);
  const entries = failedEntries();
  const exhausted = entries.find(e => e.reason?.includes('retries exhausted'));
  check('T8a flush retries exactly twice (3 send attempts)', sendAttempts === 3, `sendAttempts=${sendAttempts}`);
  check('T8a retried counter === 2', p.metrics.retried.moderation === 2, `retried=${p.metrics.retried.moderation}`);
  check('T8a exhaustion persisted to failed-events', Boolean(exhausted), entries.map(e => e.reason).join(' | '));
  check('T8a queue drained (no infinite retry)', p.metrics.queueDepth.moderation === 0 && p.pendingMod.length === 0);
}

// ——— T8b: process()-level bounded retry (guild fetch fails) ———
{
  const mockClient = { guilds: { fetch: async () => { throw new Error('guild fetch failed'); } } };
  const channels = { MOD_LOG:'mod', MEMBER:'m', SERVER:'s', VOICE_LOG:'v', MESSAGE:'msg', JOIN_LEAVE:'j' };
  const p = new EventPipeline({
    client: mockClient, channels,
    getAudit: async () => null,
    sendEmbed: async () => {},
    log: () => {}, err: () => {},
    maxLengths: { moderation: 10 },
    timing: { batchMs: 200, debounceMs: 100, suppressMs: 1000 },
  });
  p.enqueue('moderation', { type: 'ban', targetId: 'y1', targetTag: 'y1', thumb: null, guildId: 'g' });
  await sleep(4000);
  const entries = failedEntries();
  const mine = entries.filter(e => e.event?.targetId === 'y1');
  check('T8b process-level retry bounded at 2', p.metrics.retried.moderation === 2, `retried=${p.metrics.retried.moderation}`);
  check('T8b persisted after retries exhausted', mine.some(e => e.reason?.includes('retries exhausted')), mine.map(e => e.reason).join(' | '));
}

// ——— T9: FIFO preserved — batch A,B exhausted in enqueue order ———
{
  unlinkSync(FAILED_FILE);
  const mockClient = {
    guilds: { fetch: async () => ({ channels: { fetch: async () => ({ isTextBased: () => true, send: async () => { throw new Error('boom'); } }) } }) }
  };
  const channels = { MOD_LOG:'mod', MEMBER:'m', SERVER:'s', VOICE_LOG:'v', MESSAGE:'msg', JOIN_LEAVE:'j' };
  const p = new EventPipeline({
    client: mockClient, channels,
    getAudit: async () => null,
    sendEmbed: async () => {},
    log: () => {}, err: () => {},
    maxLengths: { moderation: 10 },
    timing: { batchMs: 200, debounceMs: 100, suppressMs: 1000 },
  });
  p.enqueue('moderation', { type: 'ban', targetId: 'A', targetTag: 'A', thumb: null, guildId: 'g' });
  p.enqueue('moderation', { type: 'ban', targetId: 'B', targetTag: 'B', thumb: null, guildId: 'g' });
  await sleep(6000);
  const entries = failedEntries().filter(e => e.reason?.includes('retries exhausted'));
  const ids = entries.map(e => e.event?.targetId);
  check('T9 both A and B persisted', ids.includes('A') && ids.includes('B'), `ids=${ids.join(',')}`);
  check('T9 FIFO order preserved (A before B)', ids.indexOf('A') < ids.indexOf('B') && ids.indexOf('A') !== -1, `ids=${ids.join(',')}`);
}

// ——— T10/T11: adapter pollution + happy path (needs running adapter) ———
{
  const token = readEnv('ADAPTER_TOKEN');
  if (token) {
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
    check('T10 pollution keys rejected', r10.status === 400, `got ${r10.status} ${JSON.stringify(r10.json).slice(0,120)}`);

    const r11 = await adapterCall('diagnose', {});
    check('T11 valid request accepted (timing-safe path)', r11.status === 200, `got ${r11.status}`);
  } else {
    console.log('SKIP T10/T11 (ADAPTER_TOKEN missing)');
  }
}

// ——— T12: failed-events persistence survives raw Discord objects ———
// Moderation events can carry live structures (GuildMember on leaveOrKick,
// User as audit actor) whose client references are circular. If those objects
// reached JSON.stringify, persistence would throw and the event would be
// LOST silently — violating the "moderation is never dropped" guarantee.
{
  unlinkSync(FAILED_FILE);
  const circular = { tag: 'circ', client: null };
  circular.client = { self: circular }; // mimics discord.js structure cycles
  const mockClient = { guilds: { fetch: async () => { throw new Error('guild fetch failed'); } } };
  const channels = { MOD_LOG:'mod', MEMBER:'m', SERVER:'s', VOICE_LOG:'v', MESSAGE:'msg', JOIN_LEAVE:'j' };
  const p = new EventPipeline({
    client: mockClient, channels,
    getAudit: async () => null,
    sendEmbed: async () => {},
    log: () => {}, err: () => {},
    maxLengths: { moderation: 10 },
    timing: { batchMs: 200, debounceMs: 100, suppressMs: 1000 },
  });
  p.enqueue('moderation', { type: 'leaveOrKick', targetId: 'c1', targetTag: 'circ', thumb: null, guildId: 'g', member: circular });
  await sleep(4000);
  const entries = failedEntries();
  const found = entries.filter(e => e.event?.targetId === 'c1');
  check('T12 event with circular raw object persisted (not silently lost)', found.length > 0,
    `${entries.length} lines persisted`);
  check('T12 persisted line is parseable and free of raw member object', found.length > 0 && found.every(e => e.event.member === undefined));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES PRESENT'} — pass=${pass} fail=${fail}`);
// Give in-flight socket teardown a moment before the forced exit (this file
// must exit explicitly — EventPipeline timers keep the loop alive).
await new Promise(r => setTimeout(r, 400));
process.exit(fail === 0 ? 0 : 1);
