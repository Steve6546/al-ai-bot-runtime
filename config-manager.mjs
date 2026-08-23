#!/usr/bin/env node
// config-manager.mjs — lifecycle: staged → validated → diffed → resource-validated → applied → health-checked → rollback
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, statSync, appendFileSync, copyFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CP = join(__dirname, 'control-plane.json');
const STAGED = join(__dirname, 'control-plane.staged.json');
const STATE = join(__dirname, 'bot-state.json');
const LOG = join(__dirname, 'config-lifecycle.log');

const channelId = z.string().regex(/^\d{17,20}$/);
const schema = z.object({
  schemaVersion: z.number().int().min(1),
  gateway: z.object({
    tokenEnv: z.literal('DISCORD_TOKEN'),
    singleRuntimeOnly: z.boolean(),
    allowedRuntimes: z.array(z.enum(['logger','omnicord'])),
    defaultRuntime: z.enum(['logger','omnicord'])
  }),
  supervisor: z.object({
    pidFile: z.string().min(1),
    lockFile: z.string().min(1),
    stateFile: z.string().min(1),
    logFile: z.string().min(1),
    staleLockMs: z.number().int().min(5000).max(120000),
    gracefulStopMs: z.number().int().min(1000).max(30000),
    verifyCmdline: z.boolean()
  }),
  permissions: z.object({
    ownerId: z.string().regex(/^\d{17,20}$/),
    controlPlaneAllowedRoles: z.array(z.string().min(1)),
    requireAuditForModLog: z.boolean()
  }),
  logging: z.object({
    channels: z.object({
      JOIN_LEAVE: channelId,
      VOICE_LOG: channelId,
      MOD_LOG: channelId,
      MESSAGE: channelId,
      MEMBER: channelId,
      SERVER: channelId
    }),
    debounceMs: z.number().int().min(500).max(10000),
    batchMs: z.number().int().min(500).max(20000),
    suppressMs: z.number().int().min(1000).max(30000)
  })
});

function logLifecycle(source, action, result, detail=''){
  const line = `${new Date().toISOString()} [lifecycle] source=${source} action=${action} result=${result} ${detail}`;
  console.log(line);
  try{ appendFileSync(LOG, line+'\n'); }catch{}
}
function atomicWriteJson(path, data){
  // fs.rename overwrites destination atomically on Windows; pre-unlink removed (crash window)
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmp, 'w');
  writeFileSync(fd, JSON.stringify(data, null, 2));
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
}
function loadJson(path){
  return JSON.parse(readFileSync(path,'utf8'));
}
function validateFile(path){
  const data = loadJson(path);
  const parsed = schema.safeParse(data);
  if(!parsed.success){
    const errs = parsed.error.issues.map(i=> `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`schema validation failed: ${errs}`);
  }
  return parsed.data;
}
function diffConfigs(oldData, newData){
  const changes = [];
  function walk(o,n,path=''){
    const keys = new Set([...Object.keys(o||{}), ...Object.keys(n||{})]);
    for(const k of keys){
      const p = path ? `${path}.${k}` : k;
      const ov = o?.[k], nv = n?.[k];
      if(JSON.stringify(ov) !== JSON.stringify(nv)){
        if(ov && nv && typeof ov==='object' && typeof nv==='object' && !Array.isArray(ov)){
          walk(ov,nv,p);
        } else {
          changes.push({path:p, from: ov, to: nv});
        }
      }
    }
  }
  walk(oldData, newData);
  return changes;
}
async function resourceValidate(data){
  // check Discord channels/roles exist via REST (read-only)
  const env = readFileSync(join(__dirname,'.env'),'utf8');
  const token = env.match(/DISCORD_TOKEN\s*=\s*(.+)/)[1].trim();
  const guildId = env.match(/OMNICORD_GUILD\s*=\s*(.+)/)[1].trim();
  const H = {Authorization:`Bot ${token}`};
  // check channels
  const channelsRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`,{headers:H});
  if(!channelsRes.ok) throw new Error(`channels fetch failed ${channelsRes.status}`);
  const channels = await channelsRes.json();
  const channelIds = new Set(channels.map(c=>c.id));
  for(const [name, id] of Object.entries(data.logging.channels)){
    if(!channelIds.has(id)) throw new Error(`channel ${name} id ${id} not found in guild`);
  }
  // check roles
  const rolesRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`,{headers:H});
  if(!rolesRes.ok) throw new Error(`roles fetch failed ${rolesRes.status}`);
  const roles = await rolesRes.json();
  const roleNames = new Set(roles.map(r=>r.name));
  for(const rn of data.permissions.controlPlaneAllowedRoles){
    if(!roleNames.has(rn)) throw new Error(`role ${rn} not found`);
  }
  return true;
}
function backupCurrent(){
  if(!existsSync(CP)) return;
  // rotate 5 backups: .bak.5 -> .bak.4 etc.
  for(let i=5;i>=1;i--){
    const src = i===1 ? CP : `${CP}.bak.${i-1}`;
    const dst = `${CP}.bak.${i}`;
    if(existsSync(src)){
      try{ copyFileSync(src, dst); }catch{}
    }
  }
}
async function healthCheck(){
  // check gateway lock valid and channel access
  try{
    const lock = JSON.parse(readFileSync(join(__dirname,'.bot.lock'),'utf8'));
    const alive = (()=>{ try{ process.kill(Number(lock.pid),0); return true;}catch{return false;}})();
    if(!alive) throw new Error(`gateway pid ${lock.pid} not alive`);
    // check one channel fetch
    const data = loadJson(CP);
    const env = readFileSync(join(__dirname,'.env'),'utf8');
    const token = env.match(/DISCORD_TOKEN\s*=\s*(.+)/)[1].trim();
    const H = {Authorization:`Bot ${token}`};
    const chId = data.logging.channels.MOD_LOG;
    const r = await fetch(`https://discord.com/api/v10/channels/${chId}`,{headers:H});
    if(!r.ok) throw new Error(`health check channel fetch failed ${r.status}`);
    return true;
  }catch(e){ throw new Error(`health check failed: ${e.message}`); }
}

const action = process.argv[2] || 'validate';
const source = process.argv[3] || 'cli';

(async()=>{
  try{
    if(action==='validate'){
      const target = process.argv[3] && existsSync(process.argv[3]) ? process.argv[3] : CP;
      validateFile(target);
      console.log(`validate ok: ${target}`);
      logLifecycle(source,'validate','ok',`file=${target}`);
    } else if(action==='stage'){
      // stage file already written by adapter via atomic write; validate it
      if(!existsSync(STAGED)) throw new Error('no staged file');
      const stagedData = validateFile(STAGED);
      logLifecycle(source,'stage','validated',`schemaVersion=${stagedData.schemaVersion}`);
      console.log('staged validated');
    } else if(action==='diff'){
      if(!existsSync(STAGED)) throw new Error('no staged file');
      const oldData = loadJson(CP);
      const newData = loadJson(STAGED);
      const changes = diffConfigs(oldData, newData);
      console.log(JSON.stringify(changes,null,2));
      logLifecycle(source,'diff','ok',`changes=${changes.length}`);
    } else if(action==='apply'){
      if(!existsSync(STAGED)) throw new Error('no staged file to apply');
      // 1. validate staged
      const stagedData = validateFile(STAGED);
      logLifecycle(source,'validate','ok','staged');
      // 2. diff
      const oldData = loadJson(CP);
      const changes = diffConfigs(oldData, stagedData);
      logLifecycle(source,'diff','ok',`changes=${JSON.stringify(changes).slice(0,500)}`);
      // 3. resource validate
      await resourceValidate(stagedData);
      logLifecycle(source,'resource-validate','ok');
      // 4. backup
      backupCurrent();
      logLifecycle(source,'backup','ok','kept 5');
      // 5. apply atomic
      atomicWriteJson(CP, stagedData);
      logLifecycle(source,'apply','ok',`from ${oldData.schemaVersion} to ${stagedData.schemaVersion}`);
      // 6. health check
      await new Promise(r=>setTimeout(r,1500));
      try{
        await healthCheck();
        logLifecycle(source,'health-check','ok');
        // success: remove staged
        try{ unlinkSync(STAGED);}catch{}
        console.log('apply ok — health check passed');
      }catch(e){
        logLifecycle(source,'health-check','failed',e.message);
        // rollback
        const backup = `${CP}.bak.1`;
        if(existsSync(backup)){
          const bakData = loadJson(backup);
          atomicWriteJson(CP, bakData);
          logLifecycle(source,'rollback','ok',`restored ${bakData.schemaVersion}`);
          console.log('rolled back to', bakData.schemaVersion, 'due to', e.message);
          process.exit(2);
        } else {
          throw new Error('health check failed and no backup');
        }
      }
    } else if(action==='rollback'){
      const bak = `${CP}.bak.1`;
      if(!existsSync(bak)) throw new Error('no backup');
      const bakData = loadJson(bak);
      atomicWriteJson(CP, bakData);
      logLifecycle(source,'rollback','manual',`restored ${bakData.schemaVersion}`);
      console.log('rolled back');
    } else {
      console.log('Usage: node config-manager.mjs <validate|stage|diff|apply|rollback> [source]');
    }
  }catch(e){
    logLifecycle(source, action, 'failed', e.message);
    console.error(`failed: ${e.message}`);
    process.exit(1);
  }
})();
