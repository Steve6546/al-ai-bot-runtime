// lib/env.mjs — environment access via dotenv with strict validation.
// All components read variables through this module; nobody parses .env by
// hand (hand-rolled regex broke on quotes/comments and crashed on missing
// keys with an unrelated TypeError).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { projectDir } from './paths.mjs';

export const ENV_KEYS = ['DISCORD_TOKEN', 'OMNICORD_GUILD', 'ADAPTER_TOKEN'];
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
