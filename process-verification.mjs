// process-verification.mjs — Windows implementation of process verification
// (CIM → tasklist → Get-Progress with double confirmation). Dispatched from
// lib/platform.mjs, which carries the POSIX (/proc + signals) implementation.
import { execSync } from 'node:child_process';

function tryGetCim(pid) {
  // Test hook: simulate CIM/RPC failure without touching production behavior
  // PROCESS_VERIFY_FAIL=1 → CIM only; =all → every method returns unknown
  if (process.env.PROCESS_VERIFY_FAIL === '1' || process.env.PROCESS_VERIFY_FAIL === 'all') {
    return { state: 'unknown', method: 'Get-CimInstance', reason: 'simulated RPC unavailable' };
  }
  try {
    const out = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\" | Select-Object -ExpandProperty CommandLine"`, { encoding: 'utf8', timeout: 4000 }).trim();
    if (!out) return { state: 'dead', method: 'Get-CimInstance', reason: 'empty result' };
    return { state: 'alive', method: 'Get-CimInstance', cmd: out };
  } catch (e) {
    const msg = e.message || String(e);
    if (msg.includes('Not found') || msg.includes('No instance')) return { state: 'dead', method: 'Get-CimInstance', reason: 'not found' };
    return { state: 'unknown', method: 'Get-CimInstance', reason: msg.slice(0,200) };
  }
}
function tryTasklist(pid) {
  if (process.env.PROCESS_VERIFY_FAIL === 'all') {
    return { state: 'unknown', method: 'tasklist', reason: 'simulated failure' };
  }
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', timeout: 3000 }).trim();
    // out like "node.exe","1234","Console",...
    if (!out || out.includes('No tasks')) return { state: 'dead', method: 'tasklist', reason: 'no tasks' };
    if (out.includes(String(pid))) {
      // check image name is node
      const isNode = out.toLowerCase().includes('node');
      return { state: isNode ? 'alive' : 'unknown', method: 'tasklist', reason: isNode ? 'found node' : 'found non-node', raw: out.slice(0,200) };
    }
    return { state: 'dead', method: 'tasklist', reason: 'not found' };
  } catch (e) {
    return { state: 'unknown', method: 'tasklist', reason: e.message.slice(0,200) };
  }
}
function tryGetProcess(pid) {
  if (process.env.PROCESS_VERIFY_FAIL === 'all') {
    return { state: 'unknown', method: 'Get-Process', reason: 'simulated failure' };
  }
  try {
    const out = execSync(`powershell -NoProfile -Command "Get-Process -Id ${pid} -ErrorAction Stop | Select-Object -ExpandProperty ProcessName"`, { encoding: 'utf8', timeout: 3000 }).trim();
    if (!out) return { state: 'dead', method: 'Get-Process', reason: 'empty' };
    const isNode = out.toLowerCase().includes('node');
    return { state: isNode ? 'alive' : 'unknown', method: 'Get-Process', reason: isNode ? 'node' : `process ${out}`, raw: out };
  } catch (e) {
    const msg = e.message || String(e);
    if (msg.includes('Cannot find') || msg.includes('No process')) return { state: 'dead', method: 'Get-Process', reason: 'not found' };
    return { state: 'unknown', method: 'Get-Process', reason: msg.slice(0,200) };
  }
}

export function verifyProcess(pid, expectedScript = null) {
  if (!pid) return { state: 'dead', method: 'none', reason: 'no pid' };
  // 1. Try Get-CimInstance (most reliable, gives cmdline)
  const r = tryGetCim(pid);
  if (r.state === 'alive') {
    if (expectedScript) {
      const ok = r.cmd && r.cmd.includes(expectedScript);
      if (!ok) return { state: 'unknown', method: r.method, reason: `alive but cmd mismatch (expected ${expectedScript})`, cmd: r.cmd?.slice(0,200) };
    }
    return { state: 'alive', method: r.method, reason: r.reason, cmd: r.cmd?.slice(0,300) };
  }
  if (r.state === 'dead') {
    // confirm with tasklist before declaring dead (fail-safe: need second confirmation)
    const r2 = tryTasklist(pid);
    if (r2.state === 'alive') return { state: 'alive', method: 'tasklist(double-check)', reason: r2.reason };
    if (r2.state === 'unknown') return { state: 'unknown', method: 'Get-CimInstance+tasklist', reason: `cim dead but tasklist unknown: ${r2.reason}` };
    return { state: 'dead', method: 'Get-CimInstance+tasklist', reason: `${r.reason} + ${r2.reason}` };
  }
  // r.state === unknown → try fallbacks, never declare dead on single unknown
  const r2 = tryTasklist(pid);
  if (r2.state === 'alive') return { state: 'alive', method: r2.method, reason: r2.reason };
  if (r2.state === 'dead') {
    // tasklist says dead, but Cim was unknown — need third check
    const r3 = tryGetProcess(pid);
    if (r3.state === 'alive') return { state: 'alive', method: r3.method, reason: r3.reason };
    if (r3.state === 'unknown') return { state: 'unknown', method: 'Get-CimInstance+tasklist+Get-Process', reason: `cim unknown, tasklist dead, get-process unknown: ${r3.reason}` };
    return { state: 'dead', method: 'Get-CimInstance+tasklist+Get-Process', reason: `cim unknown, tasklist dead, get-process dead` };
  }
  // r2 unknown
  const r3 = tryGetProcess(pid);
  if (r3.state === 'alive') return { state: 'alive', method: r3.method, reason: r3.reason };
  if (r3.state === 'dead') return { state: 'unknown', method: 'Get-CimInstance+tasklist+Get-Process', reason: `cim unknown, tasklist unknown, get-process dead — treat as unknown` };
  return { state: 'unknown', method: 'all', reason: `cim:${r.reason} tasklist:${r2.reason} get-process:${r3.reason}`.slice(0,300) };
}
