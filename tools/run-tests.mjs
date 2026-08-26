// tools/run-tests.mjs - one-command test runner (npm test). Hybrid v2+v1.
// Order matters: offline suites first, then adapter is started for HTTP suites.
// If .env does not exist, a local one is created with generated ADAPTER_TOKEN.
import { spawn, execSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { forceKillTree } from '../lib/platform.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ADAPTER_URL = 'http://127.0.0.1:3415/adapter/request';

function run(cmd) {
  console.log("\n>>> " + cmd);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

async function adapterUp() {
  try {
    const r = await fetch(ADAPTER_URL, { method: 'POST', body: '{}' });
    return r.status === 404 || r.status === 401 || r.status === 429;
  } catch { return false; }
}

function ensureEnvFile() {
  const envPath = join(root, '.env');
  if (existsSync(envPath)) return;
  console.log('[runner] .env not found - creating one with generated ADAPTER_TOKEN and placeholder Discord values');
  writeFileSync(envPath,
    'DISCORD_TOKEN=placeholder_not_a_real_token\n' +
    'OMNICORD_GUILD=123456789012345678\n' +
    'ADAPTER_TOKEN=' + randomBytes(32).toString('hex') + '\n');
}

async function main() {
  run('node tools/check.mjs');
  run('node test-config.mjs');
  run('node test-platform.mjs');

  // Entrypoint fail-fast (hybrid): without DISCORD_TOKEN, gateway must exit non-zero with FATAL
  {
    const envPath = join(root, '.env');
    const hadEnv = existsSync(envPath);
    let backupContent = null;
    try {
      if (hadEnv) {
        backupContent = readFileSync(envPath, 'utf8');
        writeFileSync(envPath, 'ADAPTER_TOKEN=' + randomBytes(32).toString('hex') + '\n');
      } else {
        writeFileSync(envPath, 'ADAPTER_TOKEN=' + randomBytes(32).toString('hex') + '\n');
      }
      console.log('\n>>> node index.js (expect fast DISCORD_TOKEN failure)');
      let out = '';
      try {
        out = execSync('node index.js', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
        throw new Error('entrypoint exited 0 without DISCORD_TOKEN - should have failed fast');
      } catch (e) {
        out = String(e.stdout || '') + String(e.stderr || '');
        if (!/FATAL/.test(out) || !/DISCORD_TOKEN/.test(out)) throw new Error('entrypoint did not fail with DISCORD_TOKEN FATAL: ' + out.slice(0, 300));
        console.log('PASS entrypoint fails fast with clear DISCORD_TOKEN error (no Discord contact)');
      }
    } finally {
      if (hadEnv && backupContent !== null) {
        writeFileSync(envPath, backupContent, 'utf8');
      } else {
        try { unlinkSync(envPath); } catch {}
      }
    }
  }

  run('node test-pipeline.mjs');
  ensureEnvFile();

  let child = null;
  if (!(await adapterUp())) {
    console.log('\n[runner] starting integration adapter for HTTP suites...');
    child = spawn(process.execPath, ['integration-adapter.mjs'], { cwd: root, stdio: 'ignore' });
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise(r => setTimeout(r, 250));
      up = await adapterUp();
    }
    if (!up) {
      console.error('[runner] adapter did not come up on 127.0.0.1:3415');
      if (child.pid) forceKillTree(child.pid);
      process.exit(1);
    }
  } else {
    console.log('\n[runner] reusing already-listening adapter on :3415');
  }

  try {
    run('node test-stability-fixes.mjs');
    run('node test-adapter-validation.mjs');
    run('node test-adapter-hardened.mjs');
  } finally {
    if (child && child.pid) {
      console.log('\n[runner] stopping adapter...');
      try { child.kill(); } catch {}
      await new Promise(r => setTimeout(r, 1500));
      forceKillTree(child.pid);
    }
  }
  console.log('\nALL TEST SUITES COMPLETED');
}

main().catch(e => { console.error('[runner] failed:', e.message); process.exit(1); });
