#!/usr/bin/env node
// replay-failed.mjs — replay tool for failed-events.jsonl.
// Events persisted by the pipeline (overflow, retries exhausted, shutdown
// drain) are grouped into digest embeds and re-sent to their category's log
// channel. The original file is archived only after every send succeeds;
// otherwise the unsent remainder is written back atomically.
// Usage:
//   node replay-failed.mjs [--dry-run] [--max N] [--archive]
//   npm run replay   (dry-run by default)
import { readFileSync, writeFileSync, existsSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EmbedBuilder } from 'discord.js';
import { tryResolveRuntimeConfig } from './lib/config.mjs';
import { sendEmbed } from './lib/discord.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAILED_FILE = join(__dirname, 'failed-events.jsonl');
const SEND_DELAY_MS = 400;

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const DRY_RUN = !!args['dry-run'];
const MAX_SENDS = Math.max(1, Math.min(Number(args.max) || 50, 500));
const ARCHIVE = !!args.archive || !DRY_RUN; // non-dry runs archive by default

function atomicWriteText(path, text) {
  const tmp = `${path}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, text);
    try { fsyncSync(fd); } catch {}
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, path);
}

// Same routing as EventPipeline.getChannelForCategory
function channelFor(cfg, category, ev) {
  const ch = cfg.channels;
  if (category === 'moderation') return ch.MOD_LOG;
  if (category === 'member') return ev?.type === 'join' ? ch.JOIN_LEAVE : ch.MEMBER;
  if (category === 'server') return ch.SERVER;
  if (category === 'voice') return ch.VOICE_LOG;
  return ch.MESSAGE;
}

const CATEGORY_COLORS = { moderation: 0xed4245, member: 0x57f287, server: 0xfee75c, voice: 0x5865f2, message: 0x99aab5 };
const CATEGORY_LABELS = { moderation: 'إجراء إداري', member: 'عضو', server: 'السيرفر', voice: 'فويس', message: 'رسالة' };

function describe(ev) {
  const who = ev.targetTag || ev.targetId || ev.author?.tag || ev.authorId || '?';
  const extra = ev.roles ? ` (${ev.roles.join(', ')})` : '';
  const content = ev.before !== undefined ? ` "${String(ev.before).slice(0, 60)}" -> "${String(ev.after).slice(0, 60)}"` : (ev.content ? ` "${String(ev.content).slice(0, 80)}"` : '');
  return `${ev.type || '?'}: ${who}${extra}${content}`;
}

function buildDigest(category, events) {
  const em = new EmbedBuilder()
    .setColor(CATEGORY_COLORS[category] || 0x99aab5)
    .setTimestamp()
    .setAuthor({ name: `♻️ استرجاع أحداث فاشلة — ${CATEGORY_LABELS[category] || category} (${events.length} حدث)` })
    .setDescription(events.map(e => `• [${e.lineTs}] ${describe(e.event)}`).join('\n').slice(0, 3900))
    .addFields({ name: '📝 الأسباب', value: [...new Set(events.map(e => e.reason))].join(' | ').slice(0, 900) });
  return em;
}

async function main() {
  const cfg = tryResolveRuntimeConfig();
  if (!cfg) {
    console.error('FATAL: full mode required for replay (control-plane.json + DISCORD_TOKEN + GUILD_ID)');
    process.exit(1);
  }
  if (!existsSync(FAILED_FILE)) {
    console.log('nothing to replay — failed-events.jsonl does not exist');
    return;
  }
  const lines = readFileSync(FAILED_FILE, 'utf8').split('\n').filter(Boolean);
  let entries = [];
  let bad = 0;
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { bad++; }
  }
  console.log(`loaded ${entries.length} failed events${bad ? ` (${bad} unparseable lines will be kept)` : ''}`);
  if (DRY_RUN) {
    const byCat = {};
    for (const e of entries) byCat[e.category] = (byCat[e.category] || 0) + 1;
    console.log('[dry-run] breakdown:', JSON.stringify(byCat));
    console.log('[dry-run] run with --no-dry-run (or --archive) to actually send');
    return;
  }

  // group by category, chunk into digests of <=20 events
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.category)) groups.set(e.category, []);
    groups.get(e.category).push(e);
  }
  const digests = [];
  for (const [category, evs] of groups) {
    for (let i = 0; i < evs.length; i += 20) digests.push({ category, events: evs.slice(i, i + 20) });
  }
  console.log(`sending ${digests.length} digest embed(s) (max ${MAX_SENDS})...`);

  const sentEntries = new Set();
  let sends = 0, failures = 0;
  for (const d of digests) {
    if (sends >= MAX_SENDS) { console.log(`reached --max ${MAX_SENDS}; stopping`); break; }
    const chId = channelFor(cfg, d.category, d.events[0].event);
    try {
      await sendEmbed(chId, buildDigest(d.category, d.events), cfg.token);
      sends++;
      for (const e of d.events) sentEntries.add(e);
      console.log(`sent ${d.events.length} ${d.category} event(s) -> ${chId}`);
    } catch (err) {
      failures++;
      console.error(`send failed for ${d.category}:`, err.message);
    }
    await new Promise(r => setTimeout(r, SEND_DELAY_MS));
  }

  // rewrite file with only unsent entries (atomic); archive fully-processed file
  const remaining = entries.filter(e => !sentEntries.has(e));
  if (remaining.length === 0) {
    if (ARCHIVE) {
      const stamp = new Date().toISOString().slice(0, 10);
      try { renameSync(FAILED_FILE, `${FAILED_FILE}.processed.${stamp}`); console.log(`archived to failed-events.jsonl.processed.${stamp}`); }
      catch { try { unlinkSync(FAILED_FILE); } catch {} console.log('archived (removed) failed-events.jsonl'); }
    } else {
      try { unlinkSync(FAILED_FILE); } catch {}
    }
    console.log(`replay complete: ${sends} digest(s), ${failures} failure(s)`);
  } else {
    atomicWriteText(FAILED_FILE, remaining.map(e => JSON.stringify(e)).join('\n') + '\n');
    console.log(`replay partial: ${sentEntries.size} event(s) replayed, ${remaining.length} kept in file (${failures} failure(s))`);
  }
}

main().catch(e => { console.error('replay failed:', e.message); process.exit(1); });
