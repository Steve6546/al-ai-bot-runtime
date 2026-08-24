// test-platform.mjs — cross-platform process layer. Exercises the REAL
// lifecycle of the platform abstraction (detached spawn → verify with command
// match → force-kill → verify dead) on whichever OS runs the suite, plus the
// API contracts (PID-reuse guard, test hook, entrypoint rules). No Discord,
// no real tokens. The POSIX and Windows implementations share this suite, so
// running it on either OS covers the dispatcher path that OS will use.
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { verifyProcess, verifyProcessPosix, spawnDetachedNode, forceKillTree, readCmdline, isWindows } from './lib/platform.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log(`platform: ${process.platform} (${isWindows ? 'windows layer active' : 'posix layer active'})`);

// ——— verification contracts ———
check('T-P1 no/invalid pid -> dead on both implementations',
  verifyProcess(null).state === 'dead' && verifyProcessPosix(null).state === 'dead');

{
  const v = verifyProcess(process.pid);
  check(`T-P2 self alive via dispatcher on ${process.platform}`, v.state === 'alive', `${v.state}: ${v.reason}`);
}

{
  const v = verifyProcess(process.pid, 'test-platform.mjs');
  check('T-P3 expectedScript match -> alive', v.state === 'alive', v.reason);
  const v2 = verifyProcess(process.pid, 'definitely-not-our-script.mjs');
  check('T-P4 cmd mismatch -> unknown (PID-reuse guard, never treated as ours)', v2.state === 'unknown', v2.state);
}

{
  const v = verifyProcess(999999999);
  check('T-P5 implausible pid -> dead', v.state === 'dead', v.state);
}

{
  const saved = process.env.PROCESS_VERIFY_FAIL;
  process.env.PROCESS_VERIFY_FAIL = 'all';
  const a = verifyProcess(process.pid);
  const b = verifyProcessPosix(process.pid);
  if (saved === undefined) delete process.env.PROCESS_VERIFY_FAIL; else process.env.PROCESS_VERIFY_FAIL = saved;
  check('T-P6 PROCESS_VERIFY_FAIL=all honored by dispatcher and posix impl', a.state === 'unknown' && b.state === 'unknown');
}

{
  // On Windows (no /proc) the posix impl must degrade to the signal probe and
  // still report the process alive; on Linux it reads /proc. Either way: alive.
  const v = verifyProcessPosix(process.pid);
  check('T-P7 posix impl reports self alive (signal fallback or /proc)', v.state === 'alive', `${v.state}: ${v.reason}`);
}

{
  const cmd = readCmdline(process.pid);
  check('T-P8 readCmdline exposes this process command', cmd.length > 0 && /node|test-platform/.test(cmd), cmd.slice(0, 80));
}

// ——— real detached lifecycle ———
{
  const id = randomUUID().slice(0, 8);
  const probe = join(tmpdir(), `alrt-probe-${id}.mjs`);
  const probeLog = probe + '.log';
  writeFileSync(probe, 'setTimeout(() => {}, 60000);\n');
  let pid = null;
  try {
    pid = await spawnDetachedNode({ scriptPath: probe, args: [], logOut: probeLog, cwd: tmpdir(), expectedScript: `alrt-probe-${id}` });
    await sleep(isWindows ? 2500 : 800);
    const alive = verifyProcess(pid, `alrt-probe-${id}`);
    check('T-P9 detached spawn alive with matching command', alive.state === 'alive', `${alive.state}: ${alive.reason}`);

    forceKillTree(pid);
    await sleep(isWindows ? 2000 : 800);
    const dead = verifyProcess(pid);
    check('T-P10 forceKillTree stops the detached child', dead.state === 'dead', dead.state);
  } catch (e) {
    check('T-P9 detached spawn alive with matching command', false, e.message);
    if (pid) forceKillTree(pid);
  } finally {
    try { unlinkSync(probe); } catch {}
    try { unlinkSync(probeLog); } catch {}
  }
}

// ——— entrypoint contract (Pterodactyl MAIN_FILE constraints) ———
{
  const name = 'index.js';
  check('T-P11 entrypoint exists, plain .js, name <= 16 chars', existsSync(name) && name.length <= 16);
  // strip // comment lines first — the entrypoint DOCUMENTS that it avoids
  // ts-node/TypeScript, and that prose must not trip the code check
  const code = readFileSync(name, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  check('T-P12 entrypoint is plain Node (no ts-node/TypeScript)', !/ts-node|typescript|\.ts['"]/.test(code));
  check('T-P13 entrypoint starts the gateway runtime', code.includes('gateway.mjs'));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES PRESENT'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
