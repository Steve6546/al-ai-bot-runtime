// test-stability-fixes.mjs — health-state websocket contract.
// The pipeline suites (T8a/T8b/T9/T12–T15) were removed together with the
// logging/event-pipeline system. What remains is the health-state regression:
// gatewayState must come from the REAL websocket status, never faked by a
// lock file. Requires no adapter and no network.
import { buildHealthState } from './health-state.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// discord.js Status enum: 0 Ready, 1 Connecting, 2 Reconnecting,
// 3 Idle, 4 Nearly, 5 Disconnected.
{
  const ready = buildHealthState({ wsStatus: () => 0 });
  const connecting = buildHealthState({ wsStatus: () => 1 });
  const disconnected = buildHealthState({ wsStatus: () => 5 });
  const noInfo = buildHealthState({}); // no ws info (e.g. external caller)

  check('T16 ws Ready -> connected', ready.runtime.gatewayState === 'connected', ready.runtime.gatewayState);
  check('T16 ws Connecting -> connecting', connecting.runtime.gatewayState === 'connecting', connecting.runtime.gatewayState);
  check('T16 ws Disconnected surfaced honestly', disconnected.runtime.gatewayState === 'disconnected', disconnected.runtime.gatewayState);
  check('T16 no ws info -> lock-only/starting/stopped (never fake connected)', ['lock-only','starting','stopped'].includes(noInfo.runtime.gatewayState), noInfo.runtime.gatewayState);
  check('T16 snapshot stays secret-free (no token fields)', !JSON.stringify(ready).includes('token'));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES PRESENT'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
