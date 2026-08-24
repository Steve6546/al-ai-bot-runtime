// gateway.mjs — Single Gateway Runtime (discord.js v14).
// v2 scope: an always-online, single-instance Discord gateway presence with
// health telemetry and a graceful lifecycle. The logging channels, event
// pipeline and autorole systems were removed — the runtime needs ONLY
// DISCORD_TOKEN from .env (no guild/channel/role/user IDs). Start/stop only
// through bot-supervisor.mjs; the .bot.lock below enforces single instance.
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Events } from 'discord.js';
import { startRotationWatcher } from './log-rotation.mjs';
import { startHealthWatcher } from './health-state.mjs';
// Cross-platform dispatcher: POSIX (/proc + signals) on Linux/VPS/Pterodactyl,
// Windows layer (CIM/tasklist) on win32. Never import process-verification
// directly from here — that would run PowerShell on Linux.
import { verifyProcess } from './lib/platform.mjs';
import { readEnv, ensureEnvLoaded, readEnvInt } from './lib/env.mjs';
import { gatewayLogPath } from './lib/paths.mjs';
import { atomicWriteJson } from './lib/atomic.mjs';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PID_FILE = join(__dirname, '.bot.pid');
const LOCK_FILE = join(__dirname, '.bot.lock');

// Fail fast on a missing token — before any lock is created, with one
// actionable message instead of a downstream login crash.
ensureEnvLoaded();
const TOKEN = readEnv('DISCORD_TOKEN');
if (!TOKEN) {
  console.error(new Date().toISOString(), 'FATAL: DISCORD_TOKEN is missing or empty.');
  console.error('Copy .env.example to .env and set DISCORD_TOKEN=<your bot token> (see README).');
  process.exit(1);
}

// Optional resource knob (clamped, never required) — small-VPS friendly.
const HEALTH_INTERVAL_MS = readEnvInt('HEALTH_INTERVAL_MS', 20000, 5000, 300000);
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
// Create gateway lock atomically — persists for entire gateway lifetime (fail-safe: unknown ≠ dead)
try {
  if (existsSync(LOCK_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
      const v = verifyProcess(existing.pid, 'gateway.mjs');
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
  // Exclusive atomic acquire: 'wx' fails instantly if another gateway won the race.
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

// rotation watcher (async, light) — gateway-owned logs only
try { startRotationWatcher([join(__dirname, 'supervisor.log'), gatewayLogPath()]); } catch {}

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
  await new Promise(r => setTimeout(r, 300));
  cleanupLock();
  process.exit(0);
});

const client = new Client({
  // Minimal footprint: no event listeners remain after the logging/autorole
  // removal, so NO intents are requested — nothing privileged, minimal
  // gateway bandwidth. The bot connects, shows online and serves as the
  // runtime presence; state is reported via health-state.json instead.
  intents: [],
});

client.once(Events.ClientReady, c => {
  log(`READY as ${c.user.tag} — single gateway runtime online`);
});

// health snapshot — default every 20s, lightweight, no sensitive data.
// The real websocket status is fed in so gatewayState is never faked by a
// mere lock file (connected only when client.ws.status === Ready).
try { startHealthWatcher(null, HEALTH_INTERVAL_MS, () => client.ws?.status); } catch {}

process.on('unhandledRejection', e => err('UNHANDLED', e?.message || e));
// On login failure: destroy the client and give libuv a moment to settle its
// handles before exiting — a bare process.exit() here raced the closing
// websocket handle on Windows and crashed with a libuv assertion instead of
// exiting cleanly with code 1.
client.login(TOKEN).then(() => log('logging in...')).catch(async e => {
  err('LOGIN FAIL', e.message);
  try { await client.destroy(); } catch {}
  await new Promise(r => setTimeout(r, 200));
  process.exit(1);
});
