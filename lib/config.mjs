// lib/config.mjs — unified control-plane (logging channels + timings + autorole).
// Single source for Runtime config; tolerant helpers support minimal presence
// when control-plane.json is absent.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { projectDir } from './paths.mjs';
import { ensureEnvLoaded, isSnowflake } from './env.mjs';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake (17-20 digits)');

export const controlPlaneSchema = z.object({
  schemaVersion: z.number().int().min(1),
  logging: z.object({
    channels: z.object({
      JOIN_LEAVE: snowflake,
      VOICE_LOG: snowflake,
      MOD_LOG: snowflake,
      MESSAGE: snowflake,
      MEMBER: snowflake,
      SERVER: snowflake,
    }),
    debounceMs: z.number().int().min(500).max(10000),
    batchMs: z.number().int().min(500).max(20000),
    suppressMs: z.number().int().min(1000).max(30000),
  }),
  autorole: z.object({
    enabled: z.boolean().default(true),
    memberRoleName: z.string().min(1).default('Member'),
  }).default({}),
});
// NOTE: legacy control-plane files may still carry "gateway", "supervisor" or
// "permissions" sections — zod's default object behaviour strips unknown keys,
// so those decorative sections validate away harmlessly without enforcement.

export const DEFAULT_CONTROL_PLANE_PATH = join(projectDir, 'control-plane.json');

// Partial-update schema for the adapter's stageConfig action.
// Derived from controlPlaneSchema itself (single source of truth for types and
// ranges), so the two can never drift apart. SECURITY NOTE: this schema alone
// does not block sensitive-but-schema-valid keys — the adapter must still
// apply its dangerous-key blocklist BEFORE parsing with this.
export const controlPlanePatchSchema = z.strictObject({
  schemaVersion: z.number().int().min(1),
  logging: z.strictObject({
    debounceMs: controlPlaneSchema.shape.logging.shape.debounceMs.optional(),
    batchMs: controlPlaneSchema.shape.logging.shape.batchMs.optional(),
    suppressMs: controlPlaneSchema.shape.logging.shape.suppressMs.optional(),
    channels: controlPlaneSchema.shape.logging.shape.channels.partial().optional(),
  }).optional(),
  autorole: z.strictObject({
    // .unwrap(): the source field is a ZodDefault wrapper — shape lives inside
    enabled: controlPlaneSchema.shape.autorole.unwrap().shape.enabled.optional(),
    memberRoleName: controlPlaneSchema.shape.autorole.unwrap().shape.memberRoleName.optional(),
  }).optional(),
});

/**
 * Deep-diff two config objects into a flat list of {path, from, to} changes.
 * Shared by config-manager (apply diff) and the adapter (stage response) —
 * previously two diverging implementations.
 * @returns {{path:string, from:any, to:any}[]}
 */
export function diffConfigs(oldData, newData) {
  const changes = [];
  (function walk(o, n, path = '') {
    const keys = new Set([...Object.keys(o || {}), ...Object.keys(n || {})]);
    for (const k of keys) {
      const p = path ? `${path}.${k}` : k;
      const ov = o?.[k], nv = n?.[k];
      if (JSON.stringify(ov) !== JSON.stringify(nv)) {
        if (ov && nv && typeof ov === 'object' && typeof nv === 'object' && !Array.isArray(ov)) {
          walk(ov, nv, p);
        } else {
          changes.push({ path: p, from: ov, to: nv });
        }
      }
    }
  })(oldData, newData);
  return changes;
}

/**
 * Merge a validated partial update onto a base config (single implementation
 * used by both adapter suggestConfig and stageConfig — previously duplicated).
 * @returns {object} new merged config object (base is not mutated).
 */
export function mergePartialUpdate(base, params) {
  const out = JSON.parse(JSON.stringify(base));
  if (params.logging) {
    out.logging = { ...out.logging, ...params.logging };
    if (params.logging.channels) out.logging.channels = { ...out.logging.channels, ...params.logging.channels };
  }
  if (params.autorole) out.autorole = { ...out.autorole, ...params.autorole };
  if (params.schemaVersion) out.schemaVersion = params.schemaVersion;
  return out;
}

// Human-readable one-line summary of a zod error (shared formatting).
export function schemaError(zodError) {
  return zodError.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/**
 * @typedef {Object} RuntimeConfig
 * @property {string} token                Bot token (DISCORD_TOKEN).
 * @property {string} guildId              17-20 digit snowflake.
 * @property {Object} channels             Six log channel snowflakes (JOIN_LEAVE..SERVER).
 * @property {{debounceMs:number, batchMs:number, suppressMs:number}} timing
 * @property {boolean} autoroleEnabled
 * @property {string} memberRoleName
 * @property {import('zod').infer<typeof controlPlaneSchema>} controlPlane
 */

/** Load + validate control-plane.json; throws with an actionable message. */
export function loadControlPlane(path = DEFAULT_CONTROL_PLANE_PATH) {
  if (!existsSync(path)) {
    throw new Error(
      `control-plane.json not found at ${path}. ` +
      `Copy control-plane.example.json to control-plane.json and edit it (channel IDs) — see README.`
    );
  }
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`control-plane.json is not valid JSON (${path}): ${e.message}`);
  }
  const parsed = controlPlaneSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`control-plane.json schema validation failed (${path}): ${schemaError(parsed.error)}`);
  }
  return parsed.data;
}

/** Tolerant loader for hybrid gateway: returns null if missing instead of throwing. */
export function tryLoadControlPlane(path = DEFAULT_CONTROL_PLANE_PATH) {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = controlPlaneSchema.safeParse(data);
    if (!parsed.success) {
      console.warn(`control-plane.json validation failed: ${schemaError(parsed.error)} — falling back to minimal mode`);
      return null;
    }
    return parsed.data;
  } catch (e) {
    console.warn(`control-plane.json read failed: ${e.message} — falling back to minimal mode`);
    return null;
  }
}

/** Guild-id alias chain (GUILD_ID, DISCORD_GUILD_ID, legacy OMNICORD_GUILD). */
function pickGuildId(env) {
  return (env.GUILD_ID || env.DISCORD_GUILD_ID || env.OMNICORD_GUILD || '').trim();
}

/** Strict resolver: throws listing every missing requirement. @returns {RuntimeConfig} */
export function resolveRuntimeConfig({ controlPlanePath = DEFAULT_CONTROL_PLANE_PATH, env = process.env } = {}) {
  ensureEnvLoaded();
  const cp = loadControlPlane(controlPlanePath);

  const guildIdRaw = pickGuildId(env);
  const missing = [];
  if (!String(env.DISCORD_TOKEN ?? '').trim()) missing.push('DISCORD_TOKEN');
  if (!guildIdRaw) missing.push('GUILD_ID');
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
      `Copy .env.example to .env in the project root and fill them in.`
    );
  }
  const guildId = String(guildIdRaw).trim();
  if (!isSnowflake(guildId)) {
    throw new Error(`GUILD_ID must be a Discord guild ID (17-20 digits), got: ${guildId}`);
  }

  return {
    token: String(env.DISCORD_TOKEN).trim(),
    guildId,
    channels: cp.logging.channels,
    timing: {
      debounceMs: cp.logging.debounceMs,
      batchMs: cp.logging.batchMs,
      suppressMs: cp.logging.suppressMs,
    },
    autoroleEnabled: cp.autorole.enabled,
    memberRoleName: cp.autorole.memberRoleName,
    controlPlane: cp,
  };
}
/** Returns null when full config not available — gateway will run minimal presence mode. @returns {RuntimeConfig|null} */
export function tryResolveRuntimeConfig({ controlPlanePath = DEFAULT_CONTROL_PLANE_PATH, env = process.env } = {}) {
  ensureEnvLoaded();
  const token = String(env.DISCORD_TOKEN ?? '').trim();
  if (!token) return null;
  const cp = tryLoadControlPlane(controlPlanePath);
  if (!cp) return null;
  const guildIdRaw = pickGuildId(env);
  if (!guildIdRaw || !isSnowflake(guildIdRaw)) return null;
  const guildId = guildIdRaw;
  return {
    token,
    guildId,
    channels: cp.logging.channels,
    timing: {
      debounceMs: cp.logging.debounceMs,
      batchMs: cp.logging.batchMs,
      suppressMs: cp.logging.suppressMs,
    },
    autoroleEnabled: cp.autorole.enabled,
    memberRoleName: cp.autorole.memberRoleName,
    controlPlane: cp,
  };
}
