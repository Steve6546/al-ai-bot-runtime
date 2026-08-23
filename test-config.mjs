// test-config.mjs — covers the v1.0.0 config/env fixes:
//  1. the shipped example validates against the shared schema
//  2. loadControlPlane fails with actionable errors (missing file, bad JSON, bad schema)
//  3. resolveRuntimeConfig maps .env + control-plane.json into the runtime shape
//  4. missing env keys produce one clear error listing all of them
//  5. autorole section defaults keep older control-plane.json files valid
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { controlPlaneSchema, loadControlPlane, resolveRuntimeConfig, DEFAULT_CONTROL_PLANE_PATH } from './lib/config.mjs';
import { requireEnv, readEnv, isSnowflake } from './lib/env.mjs';
import { projectDir } from './lib/paths.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const EXAMPLE = join(projectDir, 'control-plane.example.json');

// ——— 1. example file passes the schema ———
{
  const example = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  const parsed = controlPlaneSchema.safeParse(example);
  check('T-C1 example control-plane validates', parsed.success,
    parsed.error ? parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : '');
  check('T-C1b example ownerId is snowflake-shaped', isSnowflake(example.permissions.ownerId),
    `got ${example.permissions.ownerId}`);
}

// ——— 2. loadControlPlane error paths ———
const TMP = join(tmpdir(), `alrt-config-test-${Date.now()}`);
mkdirSync(TMP, { recursive: true });
const MISSING = join(TMP, 'missing.json');
{
  let msg = '';
  try { loadControlPlane(MISSING); } catch (e) { msg = e.message; }
  check('T-C2 missing file -> actionable error', msg.includes('not found') && msg.includes('control-plane.example.json'), msg);

  const BAD_JSON = join(TMP, 'bad.json');
  writeFileSync(BAD_JSON, '{not json');
  try { loadControlPlane(BAD_JSON); } catch (e) { msg = e.message; }
  check('T-C3 invalid JSON -> clear error', msg.includes('not valid JSON'), msg);

  const BAD_SCHEMA = join(TMP, 'bad-schema.json');
  const bad = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  bad.permissions.ownerId = 'YOUR_ID_HERE';
  writeFileSync(BAD_SCHEMA, JSON.stringify(bad));
  try { loadControlPlane(BAD_SCHEMA); } catch (e) { msg = e.message; }
  check('T-C4 placeholder ownerId -> schema error naming the field', msg.includes('permissions.ownerId'), msg);
}

// ——— 3. resolveRuntimeConfig happy path (temp config, injected env) ———
const GOOD_CP = join(TMP, 'good.json');
{
  const good = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  good.logging.channels.MOD_LOG = '999888777666555444';
  writeFileSync(GOOD_CP, JSON.stringify(good));
  const rc = resolveRuntimeConfig({
    controlPlanePath: GOOD_CP,
    env: { DISCORD_TOKEN: 'test-token', OMNICORD_GUILD: '1523473815555018782' },
  });
  check('T-C5 guild from env', rc.guildId === '1523473815555018782');
  check('T-C6 channels from control-plane (override visible)', rc.channels.MOD_LOG === '999888777666555444');
  check('T-C7 timing wired from control-plane', rc.timing.batchMs === good.logging.batchMs);
  check('T-C8 autorole defaults (section absent)', rc.autoroleEnabled === true && rc.memberRoleName === 'Member');
}

// ——— 4. env validation errors ———
{
  let msg = '';
  try {
    resolveRuntimeConfig({ controlPlanePath: GOOD_CP, env: {} });
  } catch (e) { msg = e.message; }
  check('T-C9 missing env -> one error listing both keys', msg.includes('DISCORD_TOKEN') && msg.includes('OMNICORD_GUILD'), msg);

  let msg2 = '';
  try {
    resolveRuntimeConfig({ controlPlanePath: GOOD_CP, env: { DISCORD_TOKEN: 'x', OMNICORD_GUILD: 'not-a-snowflake' } });
  } catch (e) { msg2 = e.message; }
  check('T-C10 non-snowflake guild -> rejected', msg2.includes('OMNICORD_GUILD') && msg2.includes('17-20'), msg2);

  let msg3 = '';
  const saved = { ...process.env };
  delete process.env.DISCORD_TOKEN; delete process.env.OMNICORD_GUILD; delete process.env.ADAPTER_TOKEN;
  try { requireEnv(['DISCORD_TOKEN', 'OMNICORD_GUILD', 'ADAPTER_TOKEN']); }
  catch (e) { msg3 = e.message; }
  Object.assign(process.env, saved);
  check('T-C11 requireEnv lists every missing key', msg3.includes('DISCORD_TOKEN') && msg3.includes('ADAPTER_TOKEN'), msg3);

  check('T-C12 isSnowflake rejects short ids', !isSnowflake('123') && isSnowflake('12345678901234567'));
}

// ——— 5. real-repo wiring sanity (no secrets required) ———
{
  // The default control-plane.json is optional until apply; loadControlPlane on
  // the default path must not throw when the file exists and matches the schema.
  if (existsSync(DEFAULT_CONTROL_PLANE_PATH)) {
    let ok = true, msg = '';
    try { loadControlPlane(); } catch (e) { ok = false; msg = e.message; }
    check('T-C13 existing control-plane.json (if any) is valid', ok, msg);
  } else {
    console.log('SKIP T-C13 (no control-plane.json in repo — expected before first setup)');
  }
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES PRESENT'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
