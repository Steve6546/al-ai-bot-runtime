// autorole-logger.mjs — Single Gateway Runtime (discord.js v14).
// Config contract (v1.0.0): guild + token come from .env (OMNICORD_GUILD,
// DISCORD_TOKEN); the six log channels, timings and autorole behavior come
// from control-plane.json via resolveRuntimeConfig(). No IDs are hardcoded.
// Start/stop only through bot-supervisor.mjs; the .bot.lock below is what
// actually enforces the single-gateway guarantee.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { EventPipeline } from './event-pipeline.mjs';
import { startRotationWatcher } from './log-rotation.mjs';
import { startHealthWatcher, setLastEvent } from './health-state.mjs';
import { verifyProcess } from './process-verification.mjs';
import { resolveRuntimeConfig } from './lib/config.mjs';
import { gatewayLogPath } from './lib/paths.mjs';
import { atomicWriteJson } from './lib/atomic.mjs';
import { randomUUID } from 'node:crypto';
import { renameSync, openSync, closeSync, fsyncSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PID_FILE = join(__dirname, '.bot.pid');
const LOCK_FILE = join(__dirname, '.bot.lock');

// Fail fast on missing/invalid env or control-plane.json — before any lock
// is created, with one actionable message instead of a downstream crash.
let RUNTIME;
try {
  RUNTIME = resolveRuntimeConfig();
} catch (e) {
  console.error(new Date().toISOString(), 'FATAL:', e.message);
  process.exit(1);
}
const { token: TOKEN, guildId: GUILD, channels: CH, timing, autoroleEnabled, memberRoleName: MEMBER_ROLE } = RUNTIME;
const log = (...a) => console.log(new Date().toISOString(), 'LOG:', ...a);
const err = (...a) => console.log(new Date().toISOString(), 'ERR:', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const LOCK_NONCE = randomUUID();
const LOCK_DATA = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  nonce: LOCK_NONCE,
  mode: 'logger',
  processCommand: `node ${process.argv[1] || 'autorole-logger.mjs'}`,
  schemaVersion: 1
};
// Create gateway lock atomically — persists for entire gateway lifetime (fail-safe: unknown ≠ dead)
try {
  if (existsSync(LOCK_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
      const v = verifyProcess(existing.pid, 'autorole-logger.mjs');
      if (v.state === 'alive') {
        console.error(new Date().toISOString(), `FATAL: .bot.lock already held by ${existing.pid} via ${v.method}`);
        process.exit(2);
      } else if (v.state === 'unknown') {
        console.error(new Date().toISOString(), `FATAL: .bot.lock state unknown for pid ${existing.pid} (${v.method}: ${v.reason.slice(0,80)}) — refusing to overwrite (fail-safe)`);
        process.exit(4);
      } else {
        console.log(new Date().toISOString(), `LOG: removing stale .bot.lock ${existing.pid} (${v.method}: ${v.reason})`);
        try { unlinkSync(LOCK_FILE); } catch {}
      }
    } catch { try { unlinkSync(LOCK_FILE); } catch {} }
  }
  // Exclusive atomic acquire: 'wx' fails instantly if another logger won the race.
  // Content is written directly into the held fd — never unlink+rename a held lock.
  let lockFd;
  try { lockFd = openSync(LOCK_FILE, 'wx'); }
  catch (e) {
    if (e.code === 'EEXIST') {
      console.error(new Date().toISOString(), 'FATAL: .bot.lock acquired concurrently by another process');
      process.exit(2);
    }
    throw e;
  }
  writeFileSync(lockFd, JSON.stringify(LOCK_DATA, null, 2));
  try { fsyncSync(lockFd); } catch {}
  closeSync(lockFd);
  atomicWriteJson(PID_FILE, LOCK_DATA.pid);
} catch (e) { console.error('lock create failed', e.message); process.exit(1); }
// rotation watcher (async, light)
const _logFiles = [
  join(__dirname, 'supervisor.log'),
  join(__dirname, 'adapter.log'),
  join(__dirname, 'failed-events.jsonl'),
  join(__dirname, 'config-lifecycle.log'),
  gatewayLogPath(),
];
try { startRotationWatcher(_logFiles); } catch {}
function cleanupLock() {
  try {
    if (!existsSync(LOCK_FILE)) return;
    const cur = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    if (String(cur.pid) === String(process.pid) && cur.nonce === LOCK_NONCE) {
      try { unlinkSync(LOCK_FILE); } catch {}
      console.log(new Date().toISOString(), 'LOG: lock released', LOCK_NONCE.slice(0,8));
    }
  } catch {}
  try { unlinkSync(PID_FILE); } catch {}
}
process.on('exit', cleanupLock);
process.on('SIGINT', async () => {
  console.log(new Date().toISOString(), 'LOG: SIGINT received');
  try { await client.destroy(); } catch {}
  cleanupLock();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  console.log(new Date().toISOString(), 'LOG: SIGTERM received — graceful destroy');
  try { await client.destroy(); } catch {}
  // log unexecuted pipeline items if any
  try {
    const pending = globalThis.__pipeline ? globalThis.__pipeline.getMetrics?.() : null;
    if (pending) console.log(new Date().toISOString(), 'LOG: pending on SIGTERM', JSON.stringify(pending));
  } catch {}
  await new Promise(r => setTimeout(r, 800));
  cleanupLock();
  process.exit(0);
});

// Audit fetch dedupe: bursts of leaves/kicks (raid, mass-mod) share ONE fetch per
// guild+type within a short window instead of N REST calls. Bounded map, TTL cleanup.
const auditInflight = new Map();   // key -> Promise<entries array or null>
const auditRecent = new Map();     // key -> {ts, entries}
const AUDIT_SHARE_MS = 2000;
const AUDIT_CACHE_MAX = 50;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of auditRecent) if (now - v.ts > AUDIT_SHARE_MS * 2) auditRecent.delete(k);
}, AUDIT_SHARE_MS);

async function getAudit(guild, type, targetId) {
  try {
    await sleep(900);
    const key = `${guild.id}:${type}`;
    let entriesPromise = auditInflight.get(key);
    if (!entriesPromise) {
      // reuse recent result if fresh (bounded small cache)
      const recent = auditRecent.get(key);
      if (recent && Date.now() - recent.ts < AUDIT_SHARE_MS) {
        entriesPromise = Promise.resolve(recent.entries);
      } else {
        entriesPromise = guild.fetchAuditLogs({ type, limit: 5 })
          .then(logs => {
            const entries = logs.entries.toArray ? logs.entries.toArray() : Array.from(logs.entries.values?.() || logs.entries);
            if (auditRecent.size > AUDIT_CACHE_MAX) auditRecent.clear();
            auditRecent.set(key, { ts: Date.now(), entries });
            return entries;
          })
          .catch(() => null);
        auditInflight.set(key, entriesPromise);
      }
    }
    const entries = await entriesPromise;
    auditInflight.delete(key);
    if (!entries) return null;
    // entries are newest-first from Discord; find newest matching target in window
    const e = entries.find(x => x.targetId === targetId && Date.now() - x.createdTimestamp < 12000);
    if (e) return { executor: e.executor, reason: e.reason || null };
  } catch {}
  return null;
}
async function sendEmbed(chId, embed) {
  try {
    const g = await client.guilds.fetch(GUILD);
    const c = await g.channels.fetch(chId);
    if (c?.isTextBased()) await c.send({ embeds: [embed] });
  } catch (e) { err('send', String(chId).slice(-4), e.message); throw e; }
}

const client = new Client({
  // GuildPresences is deliberately absent: the runtime has no presenceUpdate
  // listener, and that privileged intent only adds gateway bandwidth.
  // GuildModeration stays — guildBanAdd/guildBanRemove require it.
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  // Bounded message cache: edit/delete logs need recently cached messages
  // only, so entries older than 30 minutes are swept every 5 minutes
  // (units are seconds — discord.js guide: Cache Customization).
  sweepers: {
    messages: {
      interval: 300,
      lifetime: 1800,
    },
  },
});

// ——— Pipeline ——— single Gateway Runtime, 5 independent queues, priority moderation > member > server > voice > message
const pipeline = new EventPipeline({ client, channels: CH, getAudit, sendEmbed, log, err, timing });
globalThis.__pipeline = pipeline;
// health state — every 20s, lightweight, no sensitive data
try { startHealthWatcher(() => pipeline.getMetrics(), 20000); } catch {}
// also expose lastEvent helper for health
const _origEnqueue = pipeline.enqueue.bind(pipeline);
pipeline.enqueue = (cat, ev) => {
  try { setLastEvent(ev.type || cat); } catch {}
  return _origEnqueue(cat, ev);
};

client.once(Events.ClientReady, c => {
  log(`READY as ${c.user.tag} — guild ${GUILD} — 6 log targets from control-plane.json`);
  log(`pipeline ready — 5 queues (moderation > member > server > voice > message), timing ${JSON.stringify(timing)}`);
});

// ——— Helpers: normalize → pipeline.enqueue (no direct fetch/send in listeners) ———

// Join: immediate auto-role (config-driven, not a log), join log via pipeline member queue
client.on(Events.GuildMemberAdd, async m => {
  if (autoroleEnabled) {
    try {
      const role = m.guild.roles.cache.find(r => r.name === MEMBER_ROLE);
      if (role) { await m.roles.add(role); log('auto-role', m.user.tag); }
    } catch (e) { err('auto-role', e.message); }
  }
  pipeline.enqueue('member', {
    type: 'join',
    targetId: m.id, targetTag: m.user.tag, thumb: m.user.displayAvatarURL(),
    guildId: m.guild.id,
  });
});

// Voice — normalize and enqueue
client.on(Events.VoiceStateUpdate, async (o, n) => {
  const tag = n.member?.user?.tag || o.member?.user?.tag || 'unknown';
  const id = n.member?.id || o.member?.id || '';
  const thumb = n.member?.user?.displayAvatarURL() || o.member?.user?.displayAvatarURL() || null;
  const guildId = n.guild?.id || o.guild?.id || GUILD;
  let title, desc, color, oldCh, newCh;
  if (!o.channelId && n.channelId) { title = '🎙️ دخول صوتي'; desc = `<@${id}> دخل **${n.channel.name}**`; color = 0x5865f2; oldCh = null; newCh = n.channelId; }
  else if (o.channelId && !n.channelId) { title = '🔇 خروج صوتي'; desc = `<@${id}> خرج من **${o.channel.name}**`; color = 0x99aab5; oldCh = o.channelId; newCh = null; }
  else if (o.channelId !== n.channelId) { title = '🔁 انتقال صوتي'; desc = `<@${id}> انتقل`; color = 0xfee75c; oldCh = o.channelId; newCh = n.channelId; }
  else return;
  pipeline.enqueue('voice', {
    type: 'voice', targetId: id, targetTag: tag, thumb, guildId,
    title, desc, color, oldChannel: oldCh, newChannel: newCh,
    oldName: o.channel?.name, newName: n.channel?.name
  });
});

// Message edit/delete — pipeline message queue (lowest priority)
client.on(Events.MessageUpdate, async (oldM, newM) => {
  if (oldM.partial) try { oldM = await oldM.fetch(); } catch {}
  if (!oldM.guild || oldM.author?.bot) return;
  if ((oldM.content || '') === (newM.content || '')) return;
  pipeline.enqueue('message', {
    type: 'edit', id: oldM.id, guildId: oldM.guild.id,
    author: oldM.author, channelId: oldM.channel.id,
    before: (oldM.content || '').slice(0, 800), after: (newM.content || '').slice(0, 800),
    url: `https://discord.com/channels/${oldM.guild.id}/${oldM.channel.id}/${oldM.id}`
  });
});
client.on(Events.MessageDelete, async msg => {
  if (msg.author?.bot) return;
  if (!msg.guild) return;
  const content = (msg.content || '').slice(0, 800);
  if (!content && !msg.attachments?.size) return;
  pipeline.enqueue('message', {
    type: 'delete', id: msg.id, guildId: msg.guild.id,
    author: msg.author, channelId: msg.channel.id,
    content, attachments: msg.attachments?.size || 0
  });
});

// Member update — pipeline member queue (role/nickname) + moderation for timeout
client.on(Events.GuildMemberUpdate, async (oldM, newM) => {
  // timeout detection → moderation queue (highest priority)
  const oldTO = oldM.communicationDisabledUntil?.getTime() || 0;
  const newTO = newM.communicationDisabledUntil?.getTime() || 0;
  if (oldTO !== newTO) {
    const isMute = newTO > Date.now();
    pipeline.enqueue('moderation', {
      type: isMute ? 'mute' : 'unmute',
      targetId: newM.id, targetTag: newM.user.tag, thumb: newM.user.displayAvatarURL(),
      guildId: newM.guild.id, isMute, until: newTO
    });
    return;
  }
  // role changes
  const removed = oldM.roles.cache.filter(r => !newM.roles.cache.has(r.id));
  const added = newM.roles.cache.filter(r => !oldM.roles.cache.has(r.id));
  if (removed.size) {
    pipeline.enqueue('member', {
      type: 'roleRemove', targetId: newM.id, targetTag: newM.user.tag, thumb: newM.user.displayAvatarURL(),
      guildId: newM.guild.id, roles: removed.map(r => r.name), color: 0xed4245, title: '➖ إزالة رتبة'
    });
  }
  if (added.size) {
    pipeline.enqueue('member', {
      type: 'roleAdd', targetId: newM.id, targetTag: newM.user.tag, thumb: newM.user.displayAvatarURL(),
      guildId: newM.guild.id, roles: added.map(r => r.name), color: 0x57f287, title: '➕ إضافة رتبة'
    });
  }
  if (oldM.nickname !== newM.nickname) {
    pipeline.enqueue('member', {
      type: 'nick', targetId: newM.id, targetTag: newM.user.tag, thumb: newM.user.displayAvatarURL(),
      guildId: newM.guild.id, oldNick: oldM.nickname, newNick: newM.nickname
    });
  }
});

// Ban/unban → moderation queue (highest)
client.on(Events.GuildBanAdd, async ban => {
  pipeline.enqueue('moderation', {
    type: 'ban', targetId: ban.user.id, targetTag: ban.user.tag, thumb: ban.user.displayAvatarURL(),
    guildId: ban.guild.id
  });
});
client.on(Events.GuildBanRemove, async ban => {
  pipeline.enqueue('moderation', {
    type: 'unban', targetId: ban.user.id, targetTag: ban.user.tag, thumb: ban.user.displayAvatarURL(),
    guildId: ban.guild.id
  });
});

// Leave vs Kick — moderation if kick, else joins-leaves via member queue
client.on(Events.GuildMemberRemove, async m => {
  pipeline.enqueue('moderation', {
    type: 'leaveOrKick', targetId: m.id, targetTag: m.user.tag, thumb: m.user.displayAvatarURL(),
    guildId: m.guild.id, member: m
  });
});

// Server config → server queue
client.on(Events.GuildRoleCreate, async role => {
  if (role.managed || role.tags?.botId || role.tags?.integrationId) return;
  pipeline.enqueue('server', { type: 'roleCreate', role, guildId: role.guild.id });
});
client.on(Events.GuildRoleDelete, async role => {
  if (role.managed || role.tags?.botId || role.tags?.integrationId) return;
  pipeline.enqueue('server', { type: 'roleDelete', role, guildId: role.guild.id });
});
client.on(Events.GuildRoleUpdate, async (oldR, newR) => {
  if (newR.managed || newR.tags?.botId || newR.tags?.integrationId) return;
  if (oldR.name === newR.name) return;
  pipeline.enqueue('server', { type: 'roleUpdate', oldR, newR, guildId: newR.guild.id });
});
client.on(Events.ChannelCreate, async ch => {
  if (!ch.guild) return;
  pipeline.enqueue('server', { type: 'channelCreate', channel: ch, guildId: ch.guild.id });
});
client.on(Events.ChannelDelete, async ch => {
  if (!ch.guild) return;
  pipeline.enqueue('server', { type: 'channelDelete', channel: ch, guildId: ch.guild.id });
});

process.on('unhandledRejection', e => err('UNHANDLED', e?.message || e));
client.login(TOKEN).then(() => log('logging in...')).catch(e => { err('LOGIN FAIL', e.message); process.exit(1); });
