#!/usr/bin/env node
/**
 * First-run/bootstrap command.
 * Run: npm run bootstrap
 * It installs the locked dependency tree, creates a local .env when needed,
 * generates a local adapter secret, validates the repository, then starts all configured services.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const envPath = join(root, '.env');
const envExample = join(root, '.env.example');

function run(args) {
  execFileSync(npm, args, { cwd: root, stdio: 'inherit', windowsHide: false });
}

function ensureEnv() {
  if (!existsSync(envPath)) {
    copyFileSync(envExample, envPath);
    console.log('[bootstrap] created .env from .env.example');
  }

  let env = readFileSync(envPath, 'utf8');
  if (/^ADAPTER_TOKEN\s*=\s*$/m.test(env)) {
    env = env.replace(/^ADAPTER_TOKEN\s*=\s*$/m, `ADAPTER_TOKEN=${randomBytes(32).toString('hex')}`);
    writeFileSync(envPath, env, { encoding: 'utf8', mode: 0o600 });
    console.log('[bootstrap] generated a local ADAPTER_TOKEN');
  } else if (!/^ADAPTER_TOKEN\s*=/m.test(env)) {
    env += `${env.endsWith('\n') ? '' : '\n'}ADAPTER_TOKEN=${randomBytes(32).toString('hex')}\n`;
    writeFileSync(envPath, env, { encoding: 'utf8', mode: 0o600 });
    console.log('[bootstrap] generated a local ADAPTER_TOKEN');
  }

  const tokenConfigured = /^DISCORD_TOKEN\s*=\s*(?!your_|<|$).+/mi.test(env);
  if (!tokenConfigured) {
    console.log('[bootstrap] DISCORD_TOKEN is not configured. Edit .env, then run `npm run bootstrap` again.');
    return false;
  }
  return true;
}

try {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    console.error(`[bootstrap] Node.js ${process.versions.node} detected; Node.js 22+ is required.`);
    process.exit(2);
  }

  console.log('[bootstrap] installing exact locked dependencies...');
  run(['ci']);
  ensureEnv();

  console.log('[bootstrap] running repository checks...');
  run(['run', 'check']);

  const envReady = ensureEnv();
  if (!envReady) process.exit(0);

  console.log('[bootstrap] starting unified runtime...');
  const child = spawn(process.execPath, [join(root, 'tools', 'start-all.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env },
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} catch (error) {
  console.error(`[bootstrap] failed: ${error.message}`);
  process.exit(1);
}
