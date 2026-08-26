// lib/discord.mjs — unified Discord REST service layer.
// Only the operations actually consumed by the runtime live here:
//   - getGuildChannels / getChannel (config-manager, adapter)
//   - sendEmbed / sendMessage / sendViaClientOrRest (pipeline, replay tool)
import { readEnv } from "./env.mjs";
import { sleep, isSnowflake } from "./util.mjs";

const API_BASE = "https://discord.com/api/v10";

function requireToken(token){
  const t = token || readEnv("DISCORD_TOKEN");
  if(!t) throw new Error("DISCORD_TOKEN missing — cannot call Discord");
  return t;
}

/**
 * Generic REST helper with Bot auth + rate-limit awareness.
 * On 429/503 it honors Retry-After / X-RateLimit-Reset-After when present and
 * otherwise backs off exponentially (capped at 20 s), up to 3 retries.
 * @param {string} path API path starting with "/" (after /api/v10).
 * @param {{method?:string, token?:string, body?:Object}} [opts]
 * @param {number} [attempt] internal retry counter.
 * @returns {Promise<any>} parsed JSON (null for 204).
 */
const RATE_LIMIT_MAX_RETRIES = 3;

async function discordFetch(path, {method="GET", token, body}={}, attempt=0){
  const t=requireToken(token);
  const headers={Authorization: "Bot "+t};
  if(body) headers["Content-Type"]="application/json";
  const r=await fetch(API_BASE+path, {method, headers, body: body? JSON.stringify(body): undefined});
  if(r.status===429 || r.status===503){
    let ms=1000*Math.pow(2, attempt);
    const ra=r.headers.get("retry-after") ?? r.headers.get("x-ratelimit-reset-after");
    const n=ra ? Number(ra) : NaN;
    if(Number.isFinite(n) && n>0) ms=Math.ceil(n*1000);
    ms=Math.min(ms, 20000);
    if(attempt<RATE_LIMIT_MAX_RETRIES){
      await sleep(ms);
      return discordFetch(path, {method, token, body}, attempt+1);
    }
    throw new Error(`Discord API ${r.status} ${path}: gave up after ${RATE_LIMIT_MAX_RETRIES} retries`);
  }
  if(!r.ok){
    const txt=await r.text().then(t=>t.slice(0,500)).catch(()=>"");
    throw new Error(`Discord API ${r.status} ${path}: ${txt}`);
  }
  // 204 has no body
  if(r.status===204) return null;
  return r.json();
}

export async function getGuildChannels(guildId, token){
  if(!isSnowflake(guildId)) throw new Error(`invalid guildId snowflake: ${guildId}`);
  return discordFetch(`/guilds/${guildId}/channels`, {token});
}

export async function getChannel(channelId, token){
  if(!isSnowflake(channelId)) throw new Error(`invalid channelId: ${channelId}`);
  return discordFetch(`/channels/${channelId}`, {token});
}

/** Internal sender — exposed behaviour goes through sendEmbed/sendViaClientOrRest. */
async function sendMessage(channelId, data, token){
  if(!isSnowflake(channelId)) throw new Error(`invalid channelId: ${channelId}`);
  return discordFetch(`/channels/${channelId}/messages`, {method:"POST", token, body:data});
}

export async function sendEmbed(channelId, embed, token){
  // embed can be EmbedBuilder json or plain object
  const e = embed?.toJSON ? embed.toJSON() : embed;
  return sendMessage(channelId, {embeds:[e]}, token);
}

/**
 * Unified send used by the pipeline: prefers a logged-in Client (gateway
 * cache, lower latency), falls back to the REST helper above.
 * @param {string} channelId snowflake.
 * @param {import('discord.js').EmbedBuilder} embed
 * @param {import('discord.js').Client|null} client
 * @param {string} [guildId] snowflake, enables guild-scoped channel fetch.
 */
export async function sendViaClientOrRest(channelId, embed, client, guildId){
  if(client){
    try{
      const g= guildId ? await client.guilds.fetch(guildId) : null;
      const c= g ? await g.channels.fetch(channelId) : await client.channels.fetch(channelId);
      if(c?.isTextBased()){
        await c.send({embeds:[embed]});
        return;
      }
    }catch{}
  }
  // fallback to REST
  await sendEmbed(channelId, embed);
}
