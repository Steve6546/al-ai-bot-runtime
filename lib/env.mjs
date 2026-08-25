// lib/env.mjs — environment access via dotenv with strict validation.
// All components read variables through this module; nobody parses .env by
// hand (hand-rolled regex broke on quotes/comments and crashed on missing
// keys with an unrelated TypeError).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { projectDir } from './paths.mjs';

// Required keys every deployment must provide. ADAPTER_TOKEN and the optional
// resource knobs (HEALTH_INTERVAL_MS, LOG_MAX_BYTES, LOG_RETENTION_FILES) are
// read via readEnv/readEnvInt when present but are deliberately NOT required
// here — the gateway itself needs nothing beyond DISCORD_TOKEN.
export const ENV_KEYS = ['DISCORD_TOKEN'];
const ENV_FILE = join(projectDir, '.env');

let loaded = false;
export function ensureEnvLoaded() {
  if (loaded) return;
  if (existsSync(ENV_FILE)) loadDotenv({ path: ENV_FILE, quiet: true });
  loaded = true;
}

// Returns the trimmed value or null — never throws.
export function readEnv(key) {
  ensureEnvLoaded();
  const v = process.env[key];
  return v && String(v).trim() ? String(v).trim() : null;
}

// Throws one actionable error listing every missing key at once.
export function requireEnv(keys) {
  ensureEnvLoaded();
  const missing = keys.filter(k => !readEnv(k));
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
      `Copy .env.example to .env in the project root and fill them in` +
      (existsSync(ENV_FILE) ? ' (check for empty values).' : '.')
    );
  }
  return Object.fromEntries(keys.map(k => [k, readEnv(k)]));
}

export const isSnowflake = (v) => /^\d{17,20}$/.test(String(v ?? ''));

// Unified guild ID helper — new name is GUILD_ID (or DISCORD_GUILD_ID), old OMNICORD_GUILD kept as fallback.
export function readGuildId(){
  return readEnv('GUILD_ID') || readEnv('DISCORD_GUILD_ID') || readEnv('OMNICORD_GUILD');
}

// Optional numeric setting with clamping: empty/unset/invalid falls back to the
// default, valid values are clamped into [min, max]. Used for the optional
// resource knobs (health interval, log limits, cache sweep) — never required.
export function readEnvInt(key, fallback, min, max) {
  ensureEnvLoaded();
  const raw = process.env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
