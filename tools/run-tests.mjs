// tools/run-tests.mjs — one-command test runner (npm test).
// Order matters: offline suites first, then the adapter is started (or reused
// if one is already listening) for the HTTP suites, and the rate-limit burst
// test runs LAST because it saturates the 60 req/min per-IP limiter.
// If .env does not exist, a local one is created with a generated
// ADAPTER_TOKEN and placeholder Discord values — never a real token.
import { spawn, execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ADAPTER_URL = 'http://127.0.0.1:3415/adapter/request';

function run(cmd) {
  console.log(`\n>>> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

async function adapterUp() {
  try {
    const r = await fetch(ADAPTER_URL, { method: 'POST', body: '{}' });
    return r.status === 404 || r.status === 401 || r.status === 429; // any routed response means listening
  } catch { return false; }
}

function ensureEnvFile() {
  const envPath = join(root, '.env');
  if (existsSync(envPath)) return;
  console.log('[runner] .env not found — creating one with a generated ADAPTER_TOKEN and placeholder Discord values');
  writeFileSync(envPath,
    `DISCORD_TOKEN=placeholder_not_a_real_token\n` +
    `OMNICORD_GUILD=123456789012345678\n` +
    `ADAPTER_TOKEN=${randomBytes(32).toString('hex')}\n`);
}

async function main() {
  run('node tools/check.mjs');
  run('node test-config.mjs');
  run('node test-pipeline.mjs');
  ensureEnvFile();

  // Reuse an already-listening adapter; otherwise start a child just for the
  // HTTP suites and stop it afterwards.
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
      if (child.pid) { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} }
      process.exit(1);
    }
  } else {
    console.log('\n[runner] reusing already-listening adapter on :3415');
  }

  try {
    // light HTTP suites first (rate-limit budget), burst test last
    run('node test-stability-fixes.mjs');
    run('node test-adapter-validation.mjs');
    run('node test-adapter-hardened.mjs');
  } finally {
    if (child?.pid) {
      console.log('\n[runner] stopping adapter...');
      try { child.kill(); } catch {}
      await new Promise(r => setTimeout(r, 1500));
      try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    }
  }
  console.log('\nALL TEST SUITES COMPLETED');
}

main().catch(e => { console.error('[runner] failed:', e.message); process.exit(1); });
