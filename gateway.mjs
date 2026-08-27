// gateway.mjs — Unified Single Gateway Runtime (discord.js v14).
// Final Runtime: minimal presence (only DISCORD_TOKEN, zero intents) when
// control-plane.json or GUILD_ID is missing, and full pipeline
// (6 channels, 5 queues, autorole, audit) when both are present. Unified
// Discord service via lib/discord.mjs. Single gateway, single lock, single
// pipeline — no duplication with MCP.
import { writeFileSync, existsSync, unlinkSync, openSync, closeSync, fsyncSync, watch } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, GatewayIntentBits, Partials, Events, AuditLogEvent } from 'discord.js';
import { EventPipeline } from './event-pipeline.mjs';
import { startRotationWatcher } from './log-rotation.mjs';
import { startHealthWatcher, setLastEvent, setLastError, updateHealthState } from './health-state.mjs';
import { verifyProcess } from './lib/platform.mjs';
import { readEnv, ensureEnvLoaded, readEnvInt } from './lib/env.mjs';
import { tryResolveRuntimeConfig, controlPlaneSchema, DEFAULT_CONTROL_PLANE_PATH } from './lib/config.mjs';
import { gatewayLogPath, projectDir } from './lib/paths.mjs';
import { atomicWriteJson } from './lib/atomic.mjs';
import { sendViaClientOrRest } from './lib/discord.mjs';
import { sleep, readJsonSafe } from './lib/util.mjs';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PID_FILE = join(__dirname, '.bot.pid');
const LOCK_FILE = join(__dirname, '.bot.lock');

// Fail fast on missing token - before any lock is created.
ensureEnvLoaded();
const TOKEN = readEnv('DISCORD_TOKEN');
if (!TOKEN) {
  console.error(new Date().toISOString(), 'FATAL: DISCORD_TOKEN is missing or empty.');
  console.error('Copy .env.example to .env and set DISCORD_TOKEN=<your bot token> (see README).');
  process.exit(1);
}

// Try to load full logging config (control-plane.json + GUILD_ID).
// If not available, run in minimal presence mode.
let FULL_MODE = false;
let RUNTIME = null;
try {
  const cfg = tryResolveRuntimeConfig();
  if (cfg) {
    FULL_MODE = true;
    RUNTIME = cfg;
    console.log(new Date().toISOString(), 'LOG: full logging mode enabled - guild', RUNTIME.guildId, 'channels', Object.keys(RUNTIME.channels).join(','));
  } else {
    console.log(new Date().toISOString(), 'LOG: minimal presence mode — no control-plane.json / GUILD_ID, running with zero intents');
  }
} catch (e) {
  console.warn(new Date().toISOString(), 'WARN: full config load failed, falling back to minimal mode:', e.message);
  FULL_MODE = false;
}

let CH = null;
let GUILD = null;
let timing = null;
let autoroleEnabled = false;
let MEMBER_ROLE = null;
if (FULL_MODE) {
  CH = RUNTIME.channels;
  GUILD = RUNTIME.guildId;
  timing = RUNTIME.timing;
  autoroleEnabled = RUNTIME.autoroleEnabled;
  MEMBER_ROLE = RUNTIME.memberRoleName;
}

// Optional resource knobs (clamped, never required). MESSAGE_CACHE_SWEEP only matters in full mode.
const HEALTH_INTERVAL_MS = readEnvInt('HEALTH_INTERVAL_MS', 20000, 5000, 300000);
const MESSAGE_CACHE_SWEEP_SECONDS = readEnvInt('MESSAGE_CACHE_SWEEP_SECONDS', 1800, 300, 86400);
const log = (...a) => console.log(new Date().toISOString(), 'LOG:', ...a);
const err = (...a) => console.log(new Date().toISOString(), 'ERR:', ...a);

const LOCK_NONCE = randomUUID();
const LOCK_DATA = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  nonce: LOCK_NONCE,
  mode: 'gateway',
  processCommand: `node ${process.argv[1] || 'gateway.mjs'}`,
  schemaVersion: 1
};
// Create gateway lock atomically - persists for entire gateway lifetime (fail-safe: unknown ? dead)
try {
  if (existsSync(LOCK_FILE)) {
    try {
      const existing = readJsonSafe(LOCK_FILE);
      if (!existing) throw new Error('unreadable lock');
      // Support pre-v2 locks (autorole-logger.mjs) for safe upgrades: verify against original script.
      const expectedForExisting = existing.mode === 'logger' ? 'autorole-logger.mjs' : 'gateway.mjs';
      const v = verifyProcess(existing.pid, expectedForExisting);
      if (v.state === 'alive') {
        console.error(new Date().toISOString(), `FATAL: .bot.lock already held by ${existing.pid} via ${v.method}`);
        process.exit(2);
      } else if (v.state === 'unknown') {
        console.error(new Date().toISOString(), `FATAL: .bot.lock state unknown for pid ${existing.pid} (${v.method}: ${v.reason.slice(0,80)}) - refusing to overwrite (fail-safe)`);
        process.exit(4);
      } else {
        console.log(new Date().toISOString(), `LOG: removing stale .bot.lock ${existing.pid} (${v.method}: ${v.reason})`);
        try { unlinkSync(LOCK_FILE); } catch {}
      }
    } catch (e) {
      console.error(new Date().toISOString(), 'FATAL: lock file error - refusing to proceed', e.message);
      process.exit(5);
    }
  }
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

// rotation watcher - gateway-owned logs only (plus failed-events in full mode)
try {
  const logs = [join(__dirname, 'supervisor.log'), gatewayLogPath()];
  if (FULL_MODE) logs.push(join(__dirname, 'failed-events.jsonl'), join(__dirname, 'config-lifecycle.log'));
  startRotationWatcher(logs);
} catch {}

function cleanupLock() {
  try {
    if (!existsSync(LOCK_FILE)) return;
    const cur = readJsonSafe(LOCK_FILE);
    if (!cur) return;
    if (String(cur.pid) === String(process.pid) && cur.nonce === LOCK_NONCE) {
      try { unlinkSync(LOCK_FILE); } catch {}
      console.log(new Date().toISOString(), 'LOG: lock released', LOCK_NONCE.slice(0,8));
    }
  } catch {}
  try { unlinkSync(PID_FILE); } catch {}
}
process.on('exit', cleanupLock);

// Client creation - conditional intents based on mode (no listeners in minimal mode => zero intents)
let client;
let pipeline = null;
if (FULL_MODE) {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildModeration,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
    sweepers: {
      messages: {
        interval: 300,
        lifetime: MESSAGE_CACHE_SWEEP_SECONDS,
      },
    },
  });
} else {
  client = new Client({ intents: [] });
}

// Graceful shutdown handlers - setup after client is defined so they can persist pipeline & destroy client
process.on('SIGINT', async () => {
  console.log(new Date().toISOString(), 'LOG: SIGINT received');
  try {
    if (pipeline && typeof pipeline.persistAllPending === 'function') {
      try { pipeline.persistAllPending('SIGINT'); } catch {}
    }
  } catch {}
  try { await client.destroy(); } catch {}
  cleanupLock();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  console.log(new Date().toISOString(), 'LOG: SIGTERM received - graceful destroy');
  try {
    if (pipeline && typeof pipeline.persistAllPending === 'function') {
      try { pipeline.persistAllPending('SIGTERM'); } catch {}
      const pending = pipeline.getMetrics ? pipeline.getMetrics() : null;
      if (pending) console.log(new Date().toISOString(), 'LOG: pending on SIGTERM', JSON.stringify(pending));
    }
  } catch {}
  try { await client.destroy(); } catch {}
  await new Promise(r => setTimeout(r, 800));
  cleanupLock();
  process.exit(0);
});

// Full-mode pipeline, audit dedupe, health, and event listeners
if (FULL_MODE) {
  // Audit fetch dedupe: bursts of leaves/kicks share ONE fetch per guild+type within window
  const auditInflight = new Map();
  const auditRecent = new Map();
  const AUDIT_SHARE_MS = 2000;
  const AUDIT_CACHE_MAX = 50;
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of auditRecent) if (now - v.ts > AUDIT_SHARE_MS * 2) auditRecent.delete(k);
  }, AUDIT_SHARE_MS);

  async function getAudit(guild, type, targetId) {
    try {
      // Short wait only: handlers call prefetchAudit() at event time so the
      // fetch is usually already in flight while the pipeline reaches this
      // event (was a blocking 900 ms sleep inside the serial processing loop).
      await sleep(250);
      const key = `${guild.id}:${type}`;
      let entriesPromise = auditInflight.get(key);
      if (!entriesPromise) {
        const recent = auditRecent.get(key);
        if (recent && Date.now() - recent.ts < AUDIT_SHARE_MS) {
          entriesPromise = Promise.resolve(recent.entries);
        } else {
          entriesPromise = startAuditFetch(guild, key, type);
        }
      }
      const entries = await entriesPromise;
      auditInflight.delete(key);
      if (!entries) return null;
      const e = entries.find(x => x.targetId === targetId && Date.now() - x.createdTimestamp < 12000);
      if (e) return { executor: e.executor, reason: e.reason || null };
    } catch {}
    return null;
  }

  function startAuditFetch(guild, key, type) {
    const p = guild.fetchAuditLogs({ type, limit: 5 })
      .then(logs => {
        const entries = logs.entries.toArray ? logs.entries.toArray() : Array.from(logs.entries.values?.() || logs.entries);
        if (auditRecent.size > AUDIT_CACHE_MAX) auditRecent.clear();
        auditRecent.set(key, { ts: Date.now(), entries });
        return entries;
      })
      .catch(() => null);
    auditInflight.set(key, p);
    return p;
  }

  // Fire-and-forget prefetch so audit data is ready when the queued event is
  // processed — removes the audit round-trip from the serial send path.
  function prefetchAudit(guild, type) {
    try {
      const key = `${guild.id}:${type}`;
      if (auditInflight.has(key)) return;
      const recent = auditRecent.get(key);
      if (recent && Date.now() - recent.ts < AUDIT_SHARE_MS) return;
      startAuditFetch(guild, key, type);
    } catch {}
  }

  async function sendEmbed(chId, embed) {
    try {
      await sendViaClientOrRest(chId, embed, client, GUILD);
    } catch (e) { err('send', String(chId).slice(-4), e.message); throw e; }
  }

  pipeline = new EventPipeline({ client, channels: CH, getAudit, sendEmbed, log, err, timing });
  globalThis.__pipeline = pipeline;
  try { startHealthWatcher(() => pipeline.getMetrics(), HEALTH_INTERVAL_MS, () => client.ws?.status); } catch {}
  const _origEnqueue = pipeline.enqueue.bind(pipeline);
  pipeline.enqueue = (cat, ev) => {
    try { setLastEvent(ev.type || cat); } catch {}
    return _origEnqueue(cat, ev);
  };
  const _origEnqueueJoin = pipeline.enqueueJoin.bind(pipeline);
  pipeline.enqueueJoin = ev => {
    try { setLastEvent('join'); } catch {}
    return _origEnqueueJoin(ev);
  };

  // Hot-reload: control-plane.json is written atomically (tmp + rename) by
  // config-manager/adapter, so the watcher fires on the rename. Invalid or
  // unchanged files are ignored — the running config is never left half-applied.
  // GUILD_ID and the 6 channel *names* are fixed at boot; changing guild still
  // requires a supervisor restart.
  let lastCfgJson = JSON.stringify(RUNTIME.controlPlane);
  let reloadTimer = null;
  try {
    // Watch the DIRECTORY, not the file: atomic writes replace the file via
    // rename, which orphans an inode-based file watch (silently dead on Linux).
    watch(projectDir, (event, filename) => {
      if (filename && filename !== 'control-plane.json') return;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        try {
          const raw = readJsonSafe(DEFAULT_CONTROL_PLANE_PATH);
          const parsed = controlPlaneSchema.safeParse(raw);
          if (!parsed.success) {
            log('hot-reload rejected invalid control-plane.json:', parsed.error.issues.map(i => i.message).join('; ').slice(0, 200));
            return;
          }
          const nextJson = JSON.stringify(parsed.data);
          if (nextJson === lastCfgJson) return;
          lastCfgJson = nextJson;
          CH = parsed.data.logging.channels;
          timing = { debounceMs: parsed.data.logging.debounceMs, batchMs: parsed.data.logging.batchMs, suppressMs: parsed.data.logging.suppressMs };
          autoroleEnabled = parsed.data.autorole.enabled;
          MEMBER_ROLE = parsed.data.autorole.memberRoleName;
          pipeline.CH = CH;
          pipeline.timing = timing;
          log('hot-reload applied new control-plane.json (schemaVersion', String(parsed.data.schemaVersion) + ')');
        } catch (e) { err('hot-reload failed:', e.message); }
      }, 600);
    });
    log('control-plane hot-reload watcher active');
  } catch (e) { err('hot-reload watcher unavailable:', e.message); }

  client.once(Events.ClientReady, c => {
    log(`READY as ${c.user.tag} - guild ${GUILD} - 6 log targets from control-plane.json (full mode)`);
    log(`pipeline ready - 5 queues (moderation > member > server > voice > message), timing ${JSON.stringify(timing)}`);
  });

  // Join: autorole + batched join log (raid-safe via pipeline.enqueueJoin)
  client.on(Events.GuildMemberAdd, async m => {
    if (autoroleEnabled) {
      try {
        const role = m.guild.roles.cache.find(r => r.name === MEMBER_ROLE);
        if (role) { await m.roles.add(role); log('auto-role', m.user.tag); }
      } catch (e) { err('auto-role', e.message); }
    }
    pipeline.enqueueJoin({
      type: 'join',
      targetId: m.id, targetTag: m.user.tag, thumb: m.user.displayAvatarURL(),
      guildId: m.guild.id,
    });
  });

  client.on(Events.VoiceStateUpdate, async (o, n) => {
    const tag = n.member?.user?.tag || o.member?.user?.tag || 'unknown';
    const id = n.member?.id || o.member?.id || '';
    const thumb = n.member?.user?.displayAvatarURL() || o.member?.user?.displayAvatarURL() || null;
    const guildId = n.guild?.id || o.guild?.id || GUILD;
    let title, desc, color, oldCh, newCh;
    if (!o.channelId && n.channelId) { title = '🎩 دخول الروم'; desc = `<@${id}> دخل **${n.channel.name}**`; color = 0x5865f2; oldCh = null; newCh = n.channelId; }
    else if (o.channelId && !n.channelId) { title = '🔇 خروج من الروم'; desc = `<@${id}> خرج من **${o.channel.name}**`; color = 0x99aab5; oldCh = o.channelId; newCh = null; }
    else if (o.channelId !== n.channelId) { title = '🔁 تنقّل بين الرومات'; desc = `<@${id}> تنقّل`; color = 0xfee75c; oldCh = o.channelId; newCh = n.channelId; }
    else return;
    pipeline.enqueue('voice', {
      type: 'voice', targetId: id, targetTag: tag, thumb, guildId,
      title, desc, color, oldChannel: oldCh, newChannel: newCh,
      oldName: o.channel?.name, newName: n.channel?.name
    });
  });

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

  client.on(Events.GuildMemberUpdate, async (oldM, newM) => {
    const oldTO = oldM.communicationDisabledUntil?.getTime() || 0;
    const newTO = newM.communicationDisabledUntil?.getTime() || 0;
    if (oldTO !== newTO) {
      const isMute = newTO > Date.now();
      prefetchAudit(newM.guild, AuditLogEvent.MemberUpdate);
      pipeline.enqueue('moderation', {
        type: isMute ? 'mute' : 'unmute',
        targetId: newM.id, targetTag: newM.user.tag, thumb: newM.user.displayAvatarURL(),
        guildId: newM.guild.id, isMute, until: newTO
      });
      return;
    }
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

  client.on(Events.GuildBanAdd, async ban => {
    prefetchAudit(ban.guild, AuditLogEvent.MemberBanAdd);
    pipeline.enqueue('moderation', {
      type: 'ban', targetId: ban.user.id, targetTag: ban.user.tag, thumb: ban.user.displayAvatarURL(),
      guildId: ban.guild.id
    });
  });
  client.on(Events.GuildBanRemove, async ban => {
    prefetchAudit(ban.guild, AuditLogEvent.MemberBanRemove);
    pipeline.enqueue('moderation', {
      type: 'unban', targetId: ban.user.id, targetTag: ban.user.tag, thumb: ban.user.displayAvatarURL(),
      guildId: ban.guild.id
    });
  });

  client.on(Events.GuildMemberRemove, async m => {
    prefetchAudit(m.guild, AuditLogEvent.MemberKick);
    pipeline.enqueue('moderation', {
      type: 'leaveOrKick', targetId: m.id, targetTag: m.user.tag, thumb: m.user.displayAvatarURL(),
      guildId: m.guild.id, member: m
    });
  });

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

} else {
  // Minimal mode: health + ready log only
  client.once(Events.ClientReady, c => {
    log(`READY as ${c.user.tag} - single gateway runtime online (minimal mode, zero intents)`);
  });
  try { startHealthWatcher(null, HEALTH_INTERVAL_MS, () => client.ws?.status); } catch {}
}

process.on('unhandledRejection', e => {
  err('UNHANDLED', e?.message || e);
  try { setLastError('gateway', 'unhandledRejection'); } catch {}
});
// Crash path: persist every queued event + record the error in health-state
// before exiting, so nothing buffered is lost and diagnostics stay accurate.
process.on('uncaughtException', e => {
  err('UNCAUGHT', e?.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : String(e));
  try { setLastError('gateway', 'uncaughtException'); } catch {}
  try { updateHealthState({ wsStatus: () => client?.ws?.status }); } catch {}
  try { pipeline?.persistAllPending?.('uncaughtException'); } catch {}
  process.exit(1);
});
client.login(TOKEN).then(() => log('logging in...')).catch(async e => {
  err('LOGIN FAIL', e.message);
  try { await client.destroy(); } catch {}
  await new Promise(r => setTimeout(r, 200));
  process.exit(1);
});
