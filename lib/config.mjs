// lib/config.mjs — control-plane.json is the single behavioral config source.
// The Zod schema lives here once and is shared by config-manager (validate/
// apply) and the gateway runtime (resolveRuntimeConfig), so what is validated
// is exactly what runs. Guild identity and secrets stay in .env; channels,
// timings, permissions and autorole live in control-plane.json.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { projectDir } from './paths.mjs';
import { readEnv, ensureEnvLoaded, isSnowflake } from './env.mjs';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake (17-20 digits)');

export const controlPlaneSchema = z.object({
  schemaVersion: z.number().int().min(1),
  gateway: z.object({
    tokenEnv: z.literal('DISCORD_TOKEN'),
    singleRuntimeOnly: z.boolean(),
    allowedRuntimes: z.array(z.enum(['logger', 'omnicord'])),
    defaultRuntime: z.enum(['logger', 'omnicord']),
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
  // Optional since v1.0.0 — older control-plane.json files stay valid.
  autorole: z.object({
    enabled: z.boolean().default(true),
    memberRoleName: z.string().min(1).default('Member'),
  }).default({}),
});

export const DEFAULT_CONTROL_PLANE_PATH = join(projectDir, 'control-plane.json');

function schemaError(zodError) {
  return zodError.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

// Parses + validates a control-plane file, throwing one actionable error.
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

// Everything the gateway runtime needs, resolved from .env + control-plane.
// Throws a single clear error if either source is missing or invalid.
export function resolveRuntimeConfig({ controlPlanePath = DEFAULT_CONTROL_PLANE_PATH, env = process.env } = {}) {
  ensureEnvLoaded();
  const cp = loadControlPlane(controlPlanePath);

  const missing = [];
  if (!String(env.DISCORD_TOKEN ?? '').trim()) missing.push('DISCORD_TOKEN');
  if (!String(env.OMNICORD_GUILD ?? '').trim()) missing.push('OMNICORD_GUILD');
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
      `Copy .env.example to .env in the project root and fill them in.`
    );
  }
  const guildId = String(env.OMNICORD_GUILD).trim();
  if (!isSnowflake(guildId)) {
    throw new Error(`OMNICORD_GUILD must be a Discord guild ID (17-20 digits), got: ${guildId}`);
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
