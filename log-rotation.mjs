import { existsSync, statSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { readEnvInt } from './lib/env.mjs';

// Optional resource knobs (clamped; unset/invalid falls back to the default):
// LOG_MAX_BYTES (1MB-100MB) and LOG_RETENTION_FILES (1-100) keep rotation
// predictable on small VPSes and containers.
const MAX_BYTES = readEnvInt('LOG_MAX_BYTES', 10 * 1024 * 1024, 1024 * 1024, 100 * 1024 * 1024);
const KEEP = readEnvInt('LOG_RETENTION_FILES', 14, 1, 100);

function shouldRotate(filePath) {
  try {
    if (!existsSync(filePath)) return false;
    const st = statSync(filePath);
    if (st.size >= MAX_BYTES) return { reason: `size ${Math.round(st.size/1024/1024)}MB` };
    // daily: if mtime day != today
    const mday = new Date(st.mtime).toISOString().slice(0,10);
    const today = new Date().toISOString().slice(0,10);
    if (mday !== today) return { reason: `daily ${mday}→${today}` };
  } catch {}
  return false;
}

function rotateOne(filePath) {
  const check = shouldRotate(filePath);
  if (!check) return false;
  try {
    const dir = dirname(filePath);
    const base = basename(filePath);
    const stamp = new Date().toISOString().slice(0,10);
    // avoid collision: if dated file exists, add counter
    let dest = join(dir, `${base}.${stamp}`);
    let n = 1;
    while (existsSync(dest) && n < 100) {
      dest = join(dir, `${base}.${stamp}.${n}`);
      n++;
    }
    // async-light: rename is atomic and fast, new file will be created on next append
    renameSync(filePath, dest);
    // retention: keep last KEEP files matching base.*
    const files = readdirSync(dir).filter(f => f.startsWith(base + '.')).map(f => ({
      name: f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs
    })).sort((a,b)=> b.mtime - a.mtime);
    for (let i = KEEP; i < files.length; i++) {
      try { unlinkSync(files[i].path); } catch {}
    }
    return { rotated: dest, reason: check.reason };
  } catch (e) {
    // never throw — rotation must not affect gateway
    return { error: e.message };
  }
}

// Run rotation for a list of files, non-blocking
export function rotateLogs(filePaths) {
  // run async in next tick, light
  setImmediate(() => {
    for (const p of filePaths) {
      try { rotateOne(p); } catch {}
    }
  });
}

// Periodic checker (call once)
export function startRotationWatcher(filePaths, intervalMs = 60 * 1000) {
  setInterval(() => rotateLogs(filePaths), intervalMs);
  // also run once at startup (after 5s)
  setTimeout(() => rotateLogs(filePaths), 5000);
}
