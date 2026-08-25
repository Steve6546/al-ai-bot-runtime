// lib/config.mjs — unified control-plane (gateway + logging + permissions).
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
  gateway: z.object({
    tokenEnv: z.literal('DISCORD_TOKEN'),
    singleRuntimeOnly: z.boolean(),
    allowedRuntimes: z.array(z.enum(['gateway'])),
    defaultRuntime: z.enum(['gateway']),
  }),
  supervisor: z.object({
    pidFile: z.string().min(1),
    lockFile: z.string().min(1),
    stateFile: z.string().min(1),
    logFile: z.string().min(1),
    staleLockMs: z.number().int().min(5000).max(120000),
    gracefulStopMs: z.number().int().min(1000).max(30000),
    verifyCmdline: z.boolean(),
  }),
  permissions: z.object({
    ownerId: snowflake,
    controlPlaneAllowedRoles: z.array(z.string().min(1)),
    requireAuditForModLog: z.boolean(),
  }),
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

export const DEFAULT_CONTROL_PLANE_PATH = join(projectDir, 'control-plane.json');

// Partial-update schema for the adapter's suggestConfig/stageConfig actions.
// Derived from controlPlaneSchema itself (single source of truth for types and
// ranges), so the two can never drift apart. SECURITY NOTE: this schema alone
// does not block sensitive-but-schema-valid keys (ownerId etc.) — the adapter
// must still apply its dangerous-key blocklist BEFORE parsing with this.
export const controlPlanePatchSchema = z.strictObject({
  schemaVersion: z.number().int().min(1),
  logging: z.strictObject({
    debounceMs: controlPlaneSchema.shape.logging.shape.debounceMs.optional(),
    batchMs: controlPlaneSchema.shape.logging.shape.batchMs.optional(),
    suppressMs: controlPlaneSchema.shape.logging.shape.suppressMs.optional(),
    channels: controlPlaneSchema.shape.logging.shape.channels.partial().optional(),
  }).optional(),
  permissions: z.strictObject({
    controlPlaneAllowedRoles: controlPlaneSchema.shape.permissions.shape.controlPlaneAllowedRoles.optional(),
    requireAuditForModLog: controlPlaneSchema.shape.permissions.shape.requireAuditForModLog.optional(),
  }).optional(),
  autorole: z.strictObject({
    // .unwrap(): the source field is a ZodDefault wrapper — shape lives inside
    enabled: controlPlaneSchema.shape.autorole.unwrap().shape.enabled.optional(),
    memberRoleName: controlPlaneSchema.shape.autorole.unwrap().shape.memberRoleName.optional(),
  }).optional(),
});

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
      `Copy control-plane.example.json to control-plane.json and edit it (channel IDs, ownerId) — see README.`
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

/** Strict resolver: throws listing every missing requirement. @returns {RuntimeConfig} */
export function resolveRuntimeConfig({ controlPlanePath = DEFAULT_CONTROL_PLANE_PATH, env = process.env } = {}) {
  ensureEnvLoaded();
  const cp = loadControlPlane(controlPlanePath);

  const guildIdRaw = (env.GUILD_ID || env.DISCORD_GUILD_ID || env.OMNICORD_GUILD || '').trim();
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
  const guildIdRaw = (env.GUILD_ID || env.DISCORD_GUILD_ID || env.OMNICORD_GUILD || '').trim();
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

export function isFullModeAvailable({ controlPlanePath = DEFAULT_CONTROL_PLANE_PATH, env = process.env } = {}) {
  return tryResolveRuntimeConfig({ controlPlanePath, env }) !== null;
}
