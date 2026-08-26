// lib/util.mjs — tiny shared helpers used across modules.
// Consolidates the previously duplicated sleep/readJsonSafe/isSnowflake
// definitions (gateway, platform, discord, supervisor, adapter, health-state).
import { readFileSync } from 'node:fs';

/** Promise-based delay. @param {number} ms */
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Parse a JSON file, returning `fallback` on any failure. */
export function readJsonSafe(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/** Discord snowflake shape check (17-20 digits). */
export const isSnowflake = v => /^\d{17,20}$/.test(String(v ?? ''));
