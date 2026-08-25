// tools/check.mjs — static checks that need no dependencies:
//  1. node --check on every .mjs file (root, lib/, tools/)
//  2. JSON.parse on package.json and control-plane.example.json
//  3. .env.example exists and declares every key the code requires
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { controlPlaneSchema } from '../lib/config.mjs';
import { ENV_KEYS } from '../lib/env.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`); };
const ok = (msg) => console.log(`PASS ${msg}`);

function listMjsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listMjsFiles(p));
    else if (name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

// 1. syntax check every module (.mjs everywhere + the index.js entrypoint)
const files = listMjsFiles(root);
if (existsSync(join(root, 'index.js'))) files.push(join(root, 'index.js'));
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    ok(`syntax ${f.slice(root.length + 1)}`);
  } catch (e) {
    fail(`syntax ${f.slice(root.length + 1)}: ${String(e.stderr).slice(0, 200)}`);
  }
}

// 1b. entrypoint naming contract (Pterodactyl-style MAIN_FILE caps)
{
  const p = join(root, 'index.js');
  if (!existsSync(p)) fail('index.js entrypoint missing');
  else if ('index.js'.length > 16) fail('entrypoint name exceeds 16 chars');
  else ok('entrypoint index.js present, name <= 16 chars');
}

// 2. JSON files parse (and the example validates against the shared schema)
for (const jf of ['package.json', 'control-plane.example.json']) {
  try {
    const data = JSON.parse(readFileSync(join(root, jf), 'utf8'));
    if (jf === 'control-plane.example.json') {
      const parsed = controlPlaneSchema.safeParse(data);
      if (!parsed.success) fail(`${jf} schema: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      else ok(`${jf} parses and validates`);
    } else {
      ok(`${jf} parses`);
    }
  } catch (e) {
    fail(`${jf}: ${e.message}`);
  }
}

// 3. .env.example declares every required key
{
  const p = join(root, '.env.example');
  if (!existsSync(p)) fail('.env.example missing');
  else {
    const content = readFileSync(p, 'utf8');
    for (const key of ENV_KEYS) {
      if (new RegExp(`^${key}=`, 'm').test(content)) ok(`.env.example declares ${key}`);
      else fail(`.env.example missing ${key}`);
    }
  }
}

console.log(failures === 0
  ? `\nCHECK OK — ${files.length} modules, JSON + env template verified`
  : `\nCHECK FAILED — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
