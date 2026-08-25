// lib/discord.mjs — unified Discord service layer.
// Single source for all Discord REST/Gateway operations used by both
// the Runtime (gateway, pipeline) and the MCP control layer (adapter).
// Prevents duplicated fetch/discord.js calls and is the only place that
// knows how to talk to Discord. All callers go through here.
import { readEnv } from "./env.mjs";

const API_BASE = "https://discord.com/api/v10";

// --- helpers ---

function requireToken(token){
  const t = token || readEnv("DISCORD_TOKEN");
  if(!t) throw new Error("DISCORD_TOKEN missing — cannot call Discord");
  return t;
}

function isSnowflake(v){ return /^\d{17,20}$/.test(String(v||"")); }

function assertGuild(guildId){
  if(!isSnowflake(guildId)) throw new Error(`invalid guildId snowflake: ${guildId}`);
}

// Generic REST helper with Bot auth
async function discordFetch(path, {method="GET", token, body}={}){
  const t=requireToken(token);
  const headers={Authorization: "Bot "+t};
  if(body) headers["Content-Type"]="application/json";
  const r=await fetch(API_BASE+path, {method, headers, body: body? JSON.stringify(body): undefined});
  if(!r.ok){
    const txt=await r.text().then(t=>t.slice(0,500)).catch(()=>"");
    throw new Error(`Discord API ${r.status} ${path}: ${txt}`);
  }
  // 204 has no body
  if(r.status===204) return null;
  return r.json();
}

// --- Guild & Channels ---

export async function getGuild(guildId, token){
  assertGuild(guildId);
  return discordFetch(`/guilds/${guildId}`, {token});
}

export async function listGuilds(token){
  return discordFetch(`/users/@me/guilds`, {token});
}

export async function getGuildChannels(guildId, token){
  assertGuild(guildId);
  return discordFetch(`/guilds/${guildId}/channels`, {token});
}

export async function getChannel(channelId, token){
  if(!isSnowflake(channelId)) throw new Error(`invalid channelId: ${channelId}`);
  return discordFetch(`/channels/${channelId}`, {token});
}

export async function createChannel(guildId, data, token){
  assertGuild(guildId);
  return discordFetch(`/guilds/${guildId}/channels`, {method:"POST", token, body:data});
}

export async function editChannel(channelId, data, token){
  if(!isSnowflake(channelId)) throw new Error(`invalid channelId: ${channelId}`);
  return discordFetch(`/channels/${channelId}`, {method:"PATCH", token, body:data});
}

export async function deleteChannel(channelId, token){
  if(!isSnowflake(channelId)) throw new Error(`invalid channelId: ${channelId}`);
  return discordFetch(`/channels/${channelId}`, {method:"DELETE", token});
}

// --- Roles ---

export async function getGuildRoles(guildId, token){
  assertGuild(guildId);
  return discordFetch(`/guilds/${guildId}/roles`, {token});
}

export async function createRole(guildId, data, token){
  assertGuild(guildId);
  return discordFetch(`/guilds/${guildId}/roles`, {method:"POST", token, body:data});
}

export async function editRole(guildId, roleId, data, token){
  assertGuild(guildId);
  if(!isSnowflake(roleId)) throw new Error(`invalid roleId: ${roleId}`);
  return discordFetch(`/guilds/${guildId}/roles/${roleId}`, {method:"PATCH", token, body:data});
}

export async function deleteRole(guildId, roleId, token){
  assertGuild(guildId);
  if(!isSnowflake(roleId)) throw new Error(`invalid roleId: ${roleId}`);
  return discordFetch(`/guilds/${guildId}/roles/${roleId}`, {method:"DELETE", token});
}

// --- Members ---

export async function getGuildMember(guildId, userId, token){
  assertGuild(guildId);
  if(!isSnowflake(userId)) throw new Error(`invalid userId: ${userId}`);
  return discordFetch(`/guilds/${guildId}/members/${userId}`, {token});
}

export async function listGuildMembers(guildId, token, limit=100){
  assertGuild(guildId);
  return discordFetch(`/guilds/${guildId}/members?limit=${limit}`, {token});
}

export async function addRoleToMember(guildId, userId, roleId, token){
  assertGuild(guildId);
  if(!isSnowflake(userId) || !isSnowflake(roleId)) throw new Error("invalid id");
  return discordFetch(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, {method:"PUT", token});
}

export async function removeRoleFromMember(guildId, userId, roleId, token){
  assertGuild(guildId);
  if(!isSnowflake(userId) || !isSnowflake(roleId)) throw new Error("invalid id");
  return discordFetch(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, {method:"DELETE", token});
}

// --- Messages ---

export async function sendMessage(channelId, data, token){
  if(!isSnowflake(channelId)) throw new Error(`invalid channelId: ${channelId}`);
  return discordFetch(`/channels/${channelId}/messages`, {method:"POST", token, body:data});
}

export async function sendEmbed(channelId, embed, token){
  // embed can be EmbedBuilder json or plain object
  const e = embed?.toJSON ? embed.toJSON() : embed;
  return sendMessage(channelId, {embeds:[e]}, token);
}

export async function getMessage(channelId, messageId, token){
  if(!isSnowflake(channelId) || !isSnowflake(messageId)) throw new Error("invalid id");
  return discordFetch(`/channels/${channelId}/messages/${messageId}`, {token});
}

export async function editMessage(channelId, messageId, data, token){
  if(!isSnowflake(channelId) || !isSnowflake(messageId)) throw new Error("invalid id");
  return discordFetch(`/channels/${channelId}/messages/${messageId}`, {method:"PATCH", token, body:data});
}

export async function deleteMessage(channelId, messageId, token){
  if(!isSnowflake(channelId) || !isSnowflake(messageId)) throw new Error("invalid id");
  return discordFetch(`/channels/${channelId}/messages/${messageId}`, {method:"DELETE", token});
}

export async function listMessages(channelId, token, limit=20){
  if(!isSnowflake(channelId)) throw new Error(`invalid channelId: ${channelId}`);
  return discordFetch(`/channels/${channelId}/messages?limit=${limit}`, {token});
}

// --- Moderation ---

export async function banMember(guildId, userId, reason, token){
  assertGuild(guildId);
  if(!isSnowflake(userId)) throw new Error(`invalid userId: ${userId}`);
  const body= reason? {reason} : undefined;
  // PUT /guilds/{guild.id}/bans/{user.id}
  return discordFetch(`/guilds/${guildId}/bans/${userId}`, {method:"PUT", token, body});
}

export async function unbanMember(guildId, userId, token){
  assertGuild(guildId);
  if(!isSnowflake(userId)) throw new Error(`invalid userId: ${userId}`);
  return discordFetch(`/guilds/${guildId}/bans/${userId}`, {method:"DELETE", token});
}

export async function kickMember(guildId, userId, token){
  assertGuild(guildId);
  if(!isSnowflake(userId)) throw new Error(`invalid userId: ${userId}`);
  return discordFetch(`/guilds/${guildId}/members/${userId}`, {method:"DELETE", token});
}

export async function timeoutMember(guildId, userId, until, token){
  assertGuild(guildId);
  if(!isSnowflake(userId)) throw new Error(`invalid userId: ${userId}`);
  const body={communication_disabled_until: until ? new Date(until).toISOString() : null};
  return discordFetch(`/guilds/${guildId}/members/${userId}`, {method:"PATCH", token, body});
}

// --- Audit Logs ---

export async function getAuditLogs(guildId, params={}, token){
  assertGuild(guildId);
  const qs=new URLSearchParams();
  for(const [k,v] of Object.entries(params)) if(v) qs.set(k, String(v));
  const q=qs.toString()? "?"+qs.toString() : "";
  return discordFetch(`/guilds/${guildId}/audit-logs${q}`, {token});
}

// --- Webhooks ---

export async function getChannelWebhooks(channelId, token){
  if(!isSnowflake(channelId)) throw new Error(`invalid channelId: ${channelId}`);
  return discordFetch(`/channels/${channelId}/webhooks`, {token});
}

export async function createWebhook(channelId, data, token){
  if(!isSnowflake(channelId)) throw new Error(`invalid channelId: ${channelId}`);
  return discordFetch(`/channels/${channelId}/webhooks`, {method:"POST", token, body:data});
}

export async function deleteWebhook(webhookId, token){
  if(!isSnowflake(webhookId)) throw new Error(`invalid webhookId: ${webhookId}`);
  return discordFetch(`/webhooks/${webhookId}`, {method:"DELETE", token});
}

// --- Health helper for Gateway client path ---

// For Gateway that already has a discord.js Client, we can send via Client
// but we also expose a unified send that prefers Client if available.
export async function sendViaClientOrRest(channelId, embed, client, guildId){
  // If a logged-in Client is provided and has the guild/channel cached, use it
  // (lower latency, uses gateway cache). Otherwise fall back to REST.
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
