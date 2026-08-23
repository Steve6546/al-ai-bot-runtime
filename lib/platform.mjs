// lib/platform.mjs — cross-platform process layer.
// One API for bot-supervisor so it contains no platform branches:
//   verifyProcess(pid, expectedScript) -> {state: alive|dead|unknown, ...}
//   spawnDetachedNode({scriptPath, args, logOut, cwd, expectedScript}) -> pid
//   forceKillTree(pid), readCmdline(pid)
// POSIX implementations (/proc, signal 0, SIGKILL, direct detached spawn) live
// here. Windows keeps its proven behaviour: process verification via
// process-verification.mjs (CIM/tasklist/Get-Process, double confirmation),
// spawn via the WMI cmd wrapper (a detached `cmd /c` survives the supervisor
// and redirects output), force-kill via `taskkill /T /F`.
import { execSync, spawn } from 'node:child_process';
import { readFileSync, openSync, closeSync } from 'node:fs';
import { verifyProcess as verifyProcessWindows } from '../process-verification.mjs';

export const isWindows = process.platform === 'win32';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ——— verification ———

// POSIX: /proc/<pid>/cmdline + signal-0 probe. Liveness is always decided by
// the signal probe (ESRCH = dead, EPERM = alive); /proc supplies the command
// line for the PID-reuse guard and is allowed to be absent (non-procfs
// runtimes degrade to signal-only). 'unknown' is fail-safe: callers refuse to
// delete locks or kill on it.
export function verifyProcessPosix(pid, expectedScript = null) {
  if (!pid || !Number.isFinite(Number(pid))) return { state: 'dead', method: 'none', reason: 'no pid' };
  const hook = process.env.PROCESS_VERIFY_FAIL;
  if (hook === '1' || hook === 'all') {
    return { state: 'unknown', method: 'posix', reason: 'simulated failure' };
  }
  let cmd = null;
  try {
    cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch { /* gone, hidden, or no procfs — the signal probe decides liveness */ }
  try { process.kill(Number(pid), 0); }
  catch (e) {
    if (e.code === 'ESRCH') return { state: 'dead', method: 'signal', reason: 'no such process' };
    if (e.code === 'EPERM') return { state: 'alive', method: 'signal', reason: 'exists, owned by another user' };
    return { state: 'unknown', method: 'signal', reason: String(e.message).slice(0, 200) };
  }
  if (expectedScript) {
    if (!cmd) return { state: 'unknown', method: 'posix', reason: 'alive but cmdline unavailable' };
    // PID-reuse guard: alive process that is NOT the expected script must
    // never be treated as our bot.
    if (!cmd.includes(expectedScript)) {
      return { state: 'unknown', method: '/proc', reason: `alive but cmd mismatch (expected ${expectedScript})`, cmd: cmd.slice(0, 200) };
    }
  }
  return { state: 'alive', method: '/proc', reason: cmd ? 'cmdline read' : 'signal probe (no cmdline)', cmd: (cmd || '').slice(0, 300) };
}

export function verifyProcess(pid, expectedScript = null) {
  return isWindows
    ? verifyProcessWindows(pid, expectedScript)
    : verifyProcessPosix(pid, expectedScript);
}

// ——— command line (diagnostics only) ———
export function readCmdline(pid) {
  if (!pid) return '';
  if (isWindows) {
    try {
      return execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\" | Select-Object -ExpandProperty CommandLine"`,
        { encoding: 'utf8', timeout: 4000 }
      ).trim();
    } catch { return ''; }
  }
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { return ''; }
}

// ——— detached spawn ———

// Windows: WMI Create gives a wrapper `cmd /c` that survives the exiting
// supervisor and redirects node's output; the real node pid is resolved via
// the parent-pid chain and command-line match.
async function spawnDetachedNodeWindows({ scriptPath, args, logOut, cwd, expectedScript }) {
  const argsStr = (args || []).join(' ');
  const cmdLine = `cmd /c cd /d "${cwd}" && node "${scriptPath}" ${argsStr} > "${logOut}" 2>&1`;
  const psSafe = cmdLine.replace(/'/g, "''");
  const wmiOut = execSync(
    `powershell -NoProfile -Command "$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${psSafe}'}; Write-Output $r.ProcessId"`,
    { encoding: 'utf8' }
  ).trim();
  const cmdPid = Number(wmiOut.split(/\s+/).pop());
  let nodePid = cmdPid;
  try {
    for (let i = 0; i < 6; i++) {
      await sleep(400);
      const q = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ParentProcessId=${cmdPid}\\" | Where-Object { $_.CommandLine -like '*${expectedScript}*' } | Select-Object -ExpandProperty ProcessId"`,
        { encoding: 'utf8' }
      ).trim();
      const cand = Number(q.split(/\s+/).pop());
      const vv = verifyProcess(cand, expectedScript);
      if (cand && vv.state === 'alive') { nodePid = cand; break; }
    }
  } catch { /* keep cmd wrapper pid as fallback — the lock file holds the truth */ }
  return verifyProcess(nodePid).state === 'alive' ? nodePid : cmdPid;
}

// POSIX: direct detached node — no wrapper, so child.pid IS the gateway pid.
function spawnDetachedNodePosix({ scriptPath, args, logOut, cwd }) {
  const out = openSync(logOut, 'a');
  try {
    const child = spawn(process.execPath, [scriptPath, ...(args || [])], {
      cwd,
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(out);
  }
}

export function spawnDetachedNode(opts) {
  return isWindows ? spawnDetachedNodeWindows(opts) : Promise.resolve(spawnDetachedNodePosix(opts));
}

// ——— force kill (last resort after SIGTERM grace) ———
export function forceKillTree(pid) {
  if (!pid) return;
  if (isWindows) {
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
    return;
  }
  try { process.kill(Number(pid), 'SIGKILL'); } catch {}
}
