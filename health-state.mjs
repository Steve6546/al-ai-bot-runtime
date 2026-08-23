import { writeFileSync, openSync, closeSync, fsyncSync, unlinkSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HEALTH_FILE = join(__dirname, 'health-state.json');
const STATE_FILE = join(__dirname, 'bot-state.json');
const CP_FILE = join(__dirname, 'control-plane.json');

let lastError = null;
let lastWarnAt = 0;

function atomicWriteJson(path, data) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmp, 'w');
  writeFileSync(fd, JSON.stringify(data, null, 2));
  try { fsyncSync(fd); } catch {}
  closeSync(fd);
  try { unlinkSync(path); } catch {}
  renameSync(tmp, path);
}

function safeReadJson(path, fallback=null) {
  try { return JSON.parse(readFileSync(path,'utf8')); } catch { return fallback; }
}

// No token, no secrets, no headers, no body, no message content, no user data
export function buildHealthState({ pipelineMetrics, lastEvent, manualCircuit } = {}) {
  const state = safeReadJson(STATE_FILE, {});
  const cp = safeReadJson(CP_FILE, {});
  const mem = process.memoryUsage();
  const uptimeSec = Math.round(process.uptime());
  // gateway lock info (non-sensitive)
  let gateway = { state: 'unknown', pid: state.pid || null, runtime: state.runtime || null };
  try {
    const lock = safeReadJson(join(__dirname, '.bot.lock'), null);
    if (lock) gateway = { state: 'connected', pid: lock.pid, runtime: lock.mode, startedAt: lock.startedAt };
    else gateway.state = state.pid ? 'starting' : 'stopped';
  } catch {}

  const health = {
    schemaVersion: cp.schemaVersion || 1,
    runtime: {
      mode: state.runtime || null,
      nodePid: process.pid,
      gatewayPid: gateway.pid,
      gatewayState: gateway.state, // connected | starting | stopped | unknown
      uptimeSec,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
    },
    pipeline: pipelineMetrics || null, // {queueDepth, oldestAgeMs, sent, failed, retried, dropped, circuitState}
    circuits: manualCircuit || null,
    lastEvent: lastEvent ? { ts: lastEvent.ts, type: lastEvent.type } : null, // only timestamp/type, no user data
    lastError: lastError ? { ts: lastError.ts, category: lastError.category, code: String(lastError.code).slice(0,80) } : null,
    lastConfigLifecycle: safeReadJson(join(__dirname, 'config-lifecycle.log') ? null : null) || null, // will be overwritten below
    // lastConfig from lifecycle log tail
  };
  // lastConfig lifecycle: read last line of config-lifecycle.log
  try {
    if (existsSync(join(__dirname, 'config-lifecycle.log'))) {
      const lines = readFileSync(join(__dirname, 'config-lifecycle.log'),'utf8').trim().split('\n').filter(Boolean);
      const last = lines[lines.length-1];
      if (last) health.lastConfigLifecycle = last.slice(0,500);
    }
  } catch {}
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
export function startHealthWatcher(getPipelineMetrics, intervalMs = 20000) {
  if (interval) clearInterval(interval);
  interval = setInterval(() => {
    try {
      const pm = getPipelineMetrics ? getPipelineMetrics() : null;
      const lastEvent = globalThis.__lastEvent || null;
      updateHealthState({ pipelineMetrics: pm, lastEvent });
    } catch {}
  }, intervalMs);
  // initial
  setTimeout(() => {
    try { updateHealthState({ pipelineMetrics: getPipelineMetrics ? getPipelineMetrics() : null }); } catch {}
  }, 3000);
}
