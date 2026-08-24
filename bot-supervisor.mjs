#!/usr/bin/env node
// bot-supervisor.mjs — Single Gateway Runtime manager (Windows + Linux).
// All platform-specific behaviour (process verification, detached spawn,
// force-kill, cmdline read) lives in lib/platform.mjs — this file uses only
// Node standard APIs on top of it, so the same commands run on Windows,
// Linux/VPS and containers.
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, readSync, unlinkSync, statSync, appendFileSync, fsyncSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { verifyProcess, spawnDetachedNode, forceKillTree, readCmdline, isWindows } from './lib/platform.mjs';
import { gatewayLogPath } from './lib/paths.mjs';
import { atomicWriteJson } from './lib/atomic.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PID_FILE = join(__dirname, '.bot.pid');
const LOCK_FILE = join(__dirname, '.bot.lock');
const TX_LOCK = join(__dirname, '.supervisor.lock');
const STATE_FILE = join(__dirname, 'bot-state.json');
const LOG_FILE = join(__dirname, 'supervisor.log');

// v2: one runtime — an always-online gateway presence (no logging). Legacy
// 'logger' mode maps onto it; pre-v2 .bot.lock files still verify against
// their original script so upgrades fail safe instead of bypassing locks.
const RUNTIME = {
  gateway: { script: 'gateway.mjs', name: 'gateway' },
};
const MODE_ALIASES = { logger: 'gateway' };
function normalizeMode(m){ return MODE_ALIASES[m] || m; }
function expectedScriptFor(mode){
  if (mode === 'omnicord') return 'dist/index.js';
  if (mode === 'logger') return 'autorole-logger.mjs'; // pre-v2 lock files
  return 'gateway.mjs';
}

function log(msg, extra='') {
  const line = `${new Date().toISOString()} [supervisor] ${msg}${extra ? ' | '+extra : ''}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line+'\n'); } catch {}
}
function readState(){ try{ return JSON.parse(readFileSync(STATE_FILE,'utf8')); }catch{ return {runtime:null,pid:null}; } }
function writeState(s){ atomicWriteJson(STATE_FILE, {...s, updatedAt:new Date().toISOString()}); }

// Read only the tail of a file (last `bytes`). waitForReady polls the gateway
// log every 500 ms during boot; reading the whole (up to 10 MB) file each tick
// wasted CPU and memory for no benefit. Returns '' when unavailable.
function readTail(path, bytes = 8192){
  try{
    const st = statSync(path);
    const len = Math.min(st.size, bytes);
    if(len <= 0) return '';
    const fd = openSync(path, 'r');
    try{
      const buf = Buffer.alloc(len);
      const got = readSync(fd, buf, 0, len, st.size - len);
      return buf.toString('utf8', 0, got);
    } finally { closeSync(fd); }
  } catch { return ''; }
}

function isLockValid(lock){
  if(!lock || !lock.pid) return { valid:false, reason:'no pid' };
  const v = verifyProcess(lock.pid, expectedScriptFor(lock.mode));
  if(v.state === 'alive') return { valid:true, reason:`alive via ${v.method}` };
  if(v.state === 'unknown') return { valid:false, reason:`unknown — treat as not dead`, unknown:true, detail:v };
  return { valid:false, reason:`dead via ${v.method}: ${v.reason}` };
}
function writeTxLockContent(fd){
  // Write directly into the exclusively-held fd. NEVER unlink+rename the held lock
  // (the gap between unlink and rename would let another supervisor acquire it).
  try{
    writeFileSync(fd, JSON.stringify({pid:process.pid, at:new Date().toISOString(), nonce:randomUUID()}));
    try{ fsyncSync(fd); }catch{}
  }catch{}
}
function acquireTxLock(){
  let fd;
  try{
    fd = openSync(TX_LOCK,'wx');
  }catch(e){
    if(e.code!=='EEXIST') throw e;
    try{
      let tx=null; try{ tx=JSON.parse(readFileSync(TX_LOCK,'utf8'));}catch{ tx=null; }
      const pid=tx?.pid;
      const v = pid ? verifyProcess(pid, 'bot-supervisor') : {state:'unknown'};
      if(v.state==='dead' || !tx?.pid){
        log(`removing stale tx lock pid ${pid} state=${v.state}`);
        try{ unlinkSync(TX_LOCK);}catch{}
        fd = openSync(TX_LOCK,'wx'); // exclusive re-acquire in one atomic step
      }
      else if(v.state==='unknown'){
        log(`tx lock unknown state pid ${pid} — refusing to delete (fail-safe)`);
        return false;
      }
      else return false;
    }catch(e2){ return false; }
  }
  // we hold the exclusive lock now
  closeSync(fd);
  fd = openSync(TX_LOCK,'r+');
  writeTxLockContent(fd);
  closeSync(fd);
  return true;
}
function releaseTxLock(){ try{ unlinkSync(TX_LOCK);}catch{} }
function setLastErrorSafe(cat, code){
  try{ import('./health-state.mjs').then(m=>m.setLastError(cat,code)).catch(()=>{}); }catch{}
}

async function gracefulStop(pid, timeout=6000, expectedScript=null){
  if(!pid) { log(`no live process to stop (pid ${pid})`); return true; }
  const v = verifyProcess(pid, expectedScript);
  if(v.state==='dead'){ log(`pid ${pid} already dead`); return true; }
  if(v.state==='unknown'){
    // PID-reuse guard: alive process that is NOT our bot must never be killed
    if(expectedScript && v.reason && String(v.reason).includes('cmd mismatch')){
      log(`REFUSING to stop pid ${pid} — command does not match expected bot script (${expectedScript}). PID reuse suspected.`);
      setLastErrorSafe('supervisor','refused stop: pid mismatch');
      return false;
    }
    log(`pid ${pid} state unknown — attempting SIGTERM anyway`, v.reason?.slice(0,80));
  }
  const cmd = v.cmd || '';
  log(`graceful stop pid ${pid}`, cmd.slice(0,120));
  try{ process.kill(Number(pid),'SIGTERM'); }catch(e){ log(`SIGTERM failed: ${e.message}`); return false; }
  const start=Date.now();
  while(Date.now()-start<timeout){
    await new Promise(r=>setTimeout(r,400));
    const cur = verifyProcess(pid);
    if(cur.state==='dead'){ log(`pid ${pid} exited gracefully`); return true; }
    if(cur.state==='unknown') log(`pid ${pid} unknown during wait`);
  }
  try{ process.kill(Number(pid),'SIGKILL'); log(`force killed pid ${pid}`);}catch{}
  await new Promise(r=>setTimeout(r,600));
  const cur2 = verifyProcess(pid);
  if(cur2.state==='dead') return true;
  forceKillTree(pid);
  await new Promise(r=>setTimeout(r,600));
  const final = verifyProcess(pid);
  log(`force-kill result pid ${pid} state=${final.state}`);
  return final.state==='dead';
}
async function spawnRuntime(mode){
  const rt = RUNTIME[mode];
  if(!rt) throw new Error(`unknown runtime ${mode}`);
  const scriptPath = join(__dirname, rt.script);
  // gatewayLogPath() creates the directory if missing so output can never fail
  const logOut = gatewayLogPath();
  const pid = await spawnDetachedNode({ scriptPath, args: rt.args || [], logOut, cwd: __dirname, expectedScript: rt.script });
  log(`spawned ${mode} pid=${pid} (${isWindows ? 'wmi wrapper' : 'detached node'})`);
  return pid;
}
async function waitForReady(expectedPid, timeout=12000){
  const start=Date.now();
  while(Date.now()-start<timeout){
    const lock = (()=>{ try{ return JSON.parse(readFileSync(LOCK_FILE,'utf8'));}catch{return null;}})();
    if(lock && String(lock.pid)===String(expectedPid)){
      const vv = verifyProcess(lock.pid, expectedScriptFor('gateway'));
      if(vv.state==='alive'){
        try{
          // tail-only read: the READY line is at the end of the boot output
          const out = readTail(gatewayLogPath());
          if(out.includes('READY as')){ log(`readiness verified pid ${expectedPid}`); return true; }
        }catch{}
      } else if(vv.state==='unknown'){
        log(`readiness check unknown for pid ${expectedPid} — waiting`);
      }
    }
    await new Promise(r=>setTimeout(r,500));
  }
  log(`readiness timeout for pid ${expectedPid}`);
  return false;
}

const args = Object.fromEntries(process.argv.slice(2).map(a=>{ const [k,v]=a.replace(/^--/,'').split('='); return [k, v??true]; }));
const mode = normalizeMode((args.mode||args.m||'gateway').toLowerCase());
const action = (args.action||args.a||'start').toLowerCase();

async function status(){
  const state=readState();
  const lock = (()=>{ try{ return JSON.parse(readFileSync(LOCK_FILE,'utf8'));}catch{return null;}})();
  const pid=lock?.pid || state.pid;
  let alive=false,cmd='',detail='';
  if(pid){
    const v=verifyProcess(pid, expectedScriptFor(lock?.mode));
    alive = v.state==='alive';
    cmd = v.cmd ? v.cmd.slice(0,160) : getCmdFallback(pid);
    detail = `state=${v.state} method=${v.method}`;
  }
  console.log(JSON.stringify({state, lock, alive, detail, cmd},null,2));
  try{ if(existsSync(PID_FILE)) console.log('PID_FILE:',readFileSync(PID_FILE,'utf8').trim().slice(0,80)); }catch{}
  try{ if(existsSync(LOCK_FILE)){ const st=statSync(LOCK_FILE); console.log('LOCK_FILE age:',Math.round((Date.now()-st.mtimeMs)/1000)+'s', 'valid:', (()=>{ const l=readLock(); return l?isLockValid(l).valid:false;})()); } else console.log('LOCK_FILE: none'); }catch{}
  try{ if(existsSync(TX_LOCK)){ const st=statSync(TX_LOCK); console.log('TX_LOCK age:',Math.round((Date.now()-st.mtimeMs)/1000)+'s'); } else console.log('TX_LOCK: none'); }catch{}
  // health
  try{ const h=JSON.parse(readFileSync(join(__dirname,'health-state.json'),'utf8')); console.log('health:', JSON.stringify({gateway:h.runtime?.gatewayState, uptime:h.runtime?.uptimeSec, queues:h.pipeline?.queueDepth}).slice(0,200)); }catch{}
}
function getCmdFallback(pid){
  return readCmdline(pid).slice(0,160);
}
function readLock(){ try{ return JSON.parse(readFileSync(LOCK_FILE,'utf8'));}catch{return null;}}

async function start(){
  if(!acquireTxLock()){
    log(`FAILED to acquire tx lock — another supervisor operation in progress`);
    console.error('Another supervisor holds the lock. Try again.');
    process.exit(2);
  }
  try{
    const lock=readLock();
    if(lock){
      const chk = isLockValid(lock);
      if(chk.valid){
        log(`gateway already running pid ${lock.pid} mode=${lock.mode} — refusing start`);
        console.error(`Gateway already running pid ${lock.pid}. Use --action=restart to replace.`);
        process.exit(3);
      }
      if(chk.unknown){
        log(`gateway lock state unknown for pid ${lock.pid} — refusing to delete or start (fail-safe)`, chk.reason);
        console.error(`Gateway lock state unknown for pid ${lock.pid} — not deleting. Check manually.`);
        process.exit(4);
      }
      log(`removing stale gateway lock pid ${lock.pid} reason=${chk.reason}`);
      try{ unlinkSync(LOCK_FILE);}catch{}
      try{ unlinkSync(PID_FILE);}catch{}
    }
    log(`starting runtime mode=${mode}`);
    const pid=await spawnRuntime(mode);
    await new Promise(r=>setTimeout(r,1200));
    const vv=verifyProcess(pid);
    if(vv.state!=='alive'){ log(`FAILED spawned pid ${pid} state=${vv.state} ${vv.reason}`); process.exit(1); }
    const ready = await waitForReady(pid);
    if(!ready) log(`WARNING readiness not confirmed for pid ${pid}`);
    atomicWriteJson(STATE_FILE, {runtime:mode, pid, startedAt:new Date().toISOString(), reason:'supervisor start'});
    log(`started pid ${pid} mode=${mode} ready=${ready}`, `cmd=${getCmdFallback(pid).slice(0,120)}`);
    console.log(`Supervisor: started ${mode} pid ${pid} ready=${ready}`);
  } finally { releaseTxLock(); }
}
async function stop(){
  if(!acquireTxLock()){ console.error('Tx lock held — try again'); process.exit(2); }
  try{
    const lock=readLock();
    const state=readState();
    const pid = lock?.pid || state.pid || (existsSync(PID_FILE)?readFileSync(PID_FILE,'utf8').trim():null);
    if(!pid){ console.log('No PID to stop'); return; }
    const expected = expectedScriptFor(lock?.mode ?? state.runtime);
    const ok=await gracefulStop(pid, 6000, expected);
    const curLock=readLock();
    if(curLock && String(curLock.pid)===String(pid)){
      const chk=isLockValid(curLock);
      if(chk.valid) log(`gateway lock still valid after stop — not cleaning (unexpected)`);
      else if(chk.unknown) log(`gateway lock unknown after stop — keeping for manual check`);
      else { log(`cleaning gateway lock after stop pid ${pid}`); try{ unlinkSync(LOCK_FILE);}catch{} }
    }
    try{ if(existsSync(PID_FILE)) unlinkSync(PID_FILE);}catch{}
    atomicWriteJson(STATE_FILE, {runtime:null,pid:null,stoppedAt:new Date().toISOString(),reason:'supervisor stop'});
    console.log(ok?`Stopped pid ${pid}`:`Failed to stop pid ${pid}`);
  } finally { releaseTxLock(); }
}
(async()=>{
  if(action==='status') await status();
  else if(action==='start') await start();
  else if(action==='restart'){
    if(!acquireTxLock()){ console.error('Tx lock held'); process.exit(2); }
    try{
      const lock=readLock();
      const state=readState();
      const oldPid = lock?.pid || state.pid || (existsSync(PID_FILE)?readFileSync(PID_FILE,'utf8').trim():null);
      if(oldPid){
        const chk = lock ? isLockValid(lock) : {valid: false, unknown: false};
        if(chk.valid){
          log(`restart: stopping old pid ${oldPid}`);
          const expectedScript = expectedScriptFor(lock?.mode);
          const ok=await gracefulStop(oldPid, 6000, expectedScript);
          if(!ok) log(`WARNING old pid ${oldPid} may still be alive`);
          for(let i=0;i<5;i++){
            if(!existsSync(LOCK_FILE)) break;
            const cur=readLock();
            if(!cur || String(cur.pid)!==String(oldPid)) break;
            // if lock is unknown, don't delete — wait
            const curChk = isLockValid(cur);
            if(curChk.unknown){ log(`restart: old lock unknown — not deleting`); break; }
            await new Promise(r=>setTimeout(r,300));
          }
          try{ if(existsSync(PID_FILE)) unlinkSync(PID_FILE);}catch{}
        } else if(chk.unknown){
          log(`restart: old lock unknown for pid ${oldPid} — refusing to proceed (fail-safe)`);
          console.error(`Old lock state unknown — not proceeding with restart. Check manually.`);
          process.exit(4);
        } else {
          log(`restart: stale pid ${oldPid} not alive — cleaning`);
          try{ unlinkSync(LOCK_FILE);}catch{}
          try{ unlinkSync(PID_FILE);}catch{}
        }
      }
      log(`restart: starting new mode=${mode}`);
      const pid=await spawnRuntime(mode);
      await new Promise(r=>setTimeout(r,1200));
      const vv=verifyProcess(pid);
      if(vv.state!=='alive'){ log(`FAILED spawned pid ${pid} state=${vv.state}`); process.exit(1); }
      const ready=await waitForReady(pid);
      atomicWriteJson(STATE_FILE, {runtime:mode,pid,startedAt:new Date().toISOString(),reason:'supervisor restart'});
      log(`restarted pid ${pid} mode=${mode} ready=${ready}`, `cmd=${getCmdFallback(pid).slice(0,120)}`);
      console.log(`Supervisor: restarted ${mode} pid ${pid} ready=${ready}`);
    } finally { releaseTxLock(); }
  }
  else if(action==='stop') await stop();
  else console.log('Usage: node bot-supervisor.mjs --mode=gateway [--action=start|stop|restart|status]');
})();
