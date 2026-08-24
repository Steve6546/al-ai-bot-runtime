import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './lib/atomic.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HEALTH_FILE = join(__dirname, 'health-state.json');
const STATE_FILE = join(__dirname, 'bot-state.json');

let lastError = null;
let lastWarnAt = 0;

function safeReadJson(path, fallback=null) {
  try { return JSON.parse(readFileSync(path,'utf8')); } catch { return fallback; }
}

// discord.js client.ws.status → semantic state. Status enum:
// 0 Ready, 1 Connecting, 2 Reconnecting, 3 Idle, 4 Nearly, 5 Disconnected.
function mapWsState(ws) {
  if (typeof ws !== 'number') return null;
  const names = ['ready', 'connecting', 'reconnecting', 'idle', 'nearly', 'disconnected'];
  return names[ws] || null;
}

// No token, no secrets, no headers, no body, no message content, no user data
export function buildHealthState({ pipelineMetrics, lastEvent, manualCircuit, wsStatus } = {}) {
  const state = safeReadJson(STATE_FILE, {});
  const mem = process.memoryUsage();
  const uptimeSec = Math.round(process.uptime());
  // Gateway state: the process's OWN websocket status is the authoritative
  // signal ('connected' only when truly Ready). The lock file only corroborates
  // pid/mode metadata; its presence alone no longer fakes a connection.
  const wsState = mapWsState(typeof wsStatus === 'function' ? wsStatus() : wsStatus);
  let gateway;
  try {
    const lock = safeReadJson(join(__dirname, '.bot.lock'), null);
    gateway = {
      state: wsState
        ? (wsState === 'ready' ? 'connected' : wsState) // connected | connecting | reconnecting | idle | nearly | disconnected
        : (lock ? 'lock-only' : (state.pid ? 'starting' : 'stopped')),
      pid: lock?.pid ?? state.pid ?? null,
      runtime: lock?.mode ?? state.runtime ?? null,
    };
    if (lock) gateway.startedAt = lock.startedAt;
  } catch {
    gateway = { state: 'unknown', pid: state.pid || null, runtime: state.runtime || null };
  }

  const health = {
    schemaVersion: 1,
    runtime: {
      mode: state.runtime || null,
      nodePid: process.pid,
      gatewayPid: gateway.pid,
      gatewayState: gateway.state, // connected | connecting | reconnecting | idle | nearly | disconnected | lock-only | starting | stopped
      uptimeSec,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
    },
    pipeline: pipelineMetrics || null, // always null since the pipeline removal — kept for shape compatibility
    circuits: manualCircuit || null,
    lastEvent: lastEvent ? { ts: lastEvent.ts, type: lastEvent.type } : null, // only timestamp/type, no user data
    lastError: lastError ? { ts: lastError.ts, category: lastError.category, code: String(lastError.code).slice(0,80) } : null,
  };
  return health;
}

export function updateHealthState(opts={}) {
  try {
    const data = buildHealthState(opts);
    atomicWriteJson(HEALTH_FILE, data);
  } catch (e) {
    const now = Date.now();
    if (now - lastWarnAt > 60000) { // rate-limited warning
      lastWarnAt = now;
      console.warn(new Date().toISOString(), 'WARN health-state write failed', e.message);
    }
  }
}
export function setLastError(category, code) {
  lastError = { ts: new Date().toISOString(), category, code };
}
export function setLastEvent(type) {
  // called by pipeline on each event
  globalThis.__lastEvent = { ts: new Date().toISOString(), type };
}

let interval = null;
export function startHealthWatcher(getPipelineMetrics, intervalMs = 20000, getWsStatus = null) {
  if (interval) clearInterval(interval);
  interval = setInterval(() => {
    try {
      const pm = getPipelineMetrics ? getPipelineMetrics() : null;
      const lastEvent = globalThis.__lastEvent || null;
      updateHealthState({ pipelineMetrics: pm, lastEvent, wsStatus: getWsStatus });
    } catch {}
  }, intervalMs);
  // initial
  setTimeout(() => {
    try { updateHealthState({ pipelineMetrics: getPipelineMetrics ? getPipelineMetrics() : null, wsStatus: getWsStatus }); } catch {}
  }, 3000);
}
