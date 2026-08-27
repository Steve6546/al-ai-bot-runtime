import { EventPipeline } from './event-pipeline.mjs';

// Mock client
const mockClient = {
  guilds: { fetch: async () => ({ channels: { fetch: async () => ({ isTextBased: () => true, send: async () => {} }) } }) }
};
const channels = { MOD_LOG: 'mod', MEMBER: 'member', SERVER: 'server', VOICE_LOG: 'voice', MESSAGE: 'msg', JOIN_LEAVE: 'join' };
const sent = [];
let sendCount = 0;
async function sendEmbed(chId, embed) {
  // Deterministic failure: fail every 10th send to MOD_LOG (reproduces retry scenario)
  if (chId === 'mod' && (sendCount++ % 10) === 0) throw new Error('429 rate limited');
  sent.push({ chId, embed });
}
async function getAudit() { return null; }
function log(..._a) { /*console.log(...a)*/ }
function err(..._a) { /*console.error(...a)*/ }

const pipeline = new EventPipeline({ client: mockClient, channels, getAudit, sendEmbed, log, err, maxLengths: { moderation: 10, message: 5, voice: 5, member: 10, server: 10 } });

console.log('=== Test 1: overflow handling ===');
for (let i=0;i<15;i++) pipeline.enqueue('moderation', { type:'ban', targetId:`mod${i}`, targetTag:`mod${i}`, thumb:null, guildId:'g' });
for (let i=0;i<15;i++) pipeline.enqueue('message', { type:'delete', id:`msg${i}`, guildId:'g', author:{id:'u1',tag:'t'}, channelId:'c1', content:'hi' });
await new Promise(r=>setTimeout(r, 2000));
console.log('moderation queue depth (should be <=15, not dropped):', pipeline.metrics.queueDepth.moderation, 'failed:', pipeline.metrics.failed.moderation, 'dropped:', pipeline.metrics.dropped.moderation);
console.log('message queue depth (max 5, should have dropped):', pipeline.metrics.queueDepth.message, 'dropped:', pipeline.metrics.dropped.message, 'sent:', pipeline.metrics.sent.message);
console.log('message dropped >0 ?', pipeline.metrics.dropped.message > 0 ? 'PASS' : 'FAIL');
console.log('moderation not dropped ?', pipeline.metrics.dropped.moderation === 0 ? 'PASS' : 'FAIL (moderation should not drop)');

console.log('\n=== Test 2: fair scheduling (moderation flood should not starve others) ===');
// clear
pipeline.queues.moderation = []; pipeline.queues.message = []; pipeline.queues.voice = [];
pipeline.metrics.sent = { moderation:0, member:0, server:0, voice:0, message:0 };
pipeline.metrics.dropped = { moderation:0, member:0, server:0, voice:0, message:0 };
// flood moderation with 20, and add 5 voice and 5 message
for(let i=0;i<20;i++) pipeline.enqueue('moderation', { type:'ban', targetId:`flood-mod${i}`, targetTag:`m${i}`, guildId:'g' });
for(let i=0;i<5;i++) pipeline.enqueue('voice', { type:'voice', targetId:`v${i}`, targetTag:`v${i}`, title:'t', desc:'d', color:0, oldChannel:null, newChannel:'1', thumb:null, guildId:'g' });
for(let i=0;i<5;i++) pipeline.enqueue('message', { type:'delete', id:`flood-msg${i}`, guildId:'g', author:{id:'u1',tag:'t'}, channelId:'c1', content:'hi' });
await new Promise(r=>setTimeout(r, 5000));
console.log('sent moderation', pipeline.metrics.sent.moderation);
console.log('sent voice', pipeline.metrics.sent.voice);
console.log('sent message', pipeline.metrics.sent.message);
console.log('fair scheduling ?', (pipeline.metrics.sent.voice>0 && pipeline.metrics.sent.message>0) ? 'PASS (others got time)' : 'FAIL (starved)');

console.log('\n=== Test 3: per-channel circuit ===');
const chId = 'mod';
const circ = pipeline.getCircuit(chId);
circ.failures = 3; circ.openUntil = Date.now()+5000;
console.log('circuit open for mod?', pipeline.isCircuitOpen(chId) ? 'YES' : 'NO');
console.log('circuit open for message?', pipeline.isCircuitOpen('msg') ? 'YES (should be NO)' : 'NO (correct, per-channel)');

console.log('\n=== Test 4: metrics ===');
console.log(JSON.stringify(pipeline.getMetrics(), null, 2).slice(0,800));

console.log('\n=== Test 5: failed-events file ===');
import { readFileSync, existsSync } from 'node:fs';
if (existsSync('./failed-events.jsonl')) {
  const lines = readFileSync('./failed-events.jsonl','utf8').split('\n').filter(Boolean);
  console.log('failed-events lines:', lines.length);
  console.log(lines.slice(-2).join('\n').slice(0,500));
} else console.log('no failed file yet (expected if no moderation failures)');

console.log('\nAll tests done');
process.exit(0);
