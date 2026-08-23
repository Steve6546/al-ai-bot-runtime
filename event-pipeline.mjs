// event-pipeline.mjs — bounded queues, fair scheduling, per-channel circuit,
// metrics, failed-events persistence.
// Since v1.0.0: timings come from control-plane.json (via the constructor),
// batched moderation flushes have bounded retries with backoff before being
// persisted to failed-events.jsonl, and no guild/channel ID is hardcoded —
// every destination comes from `channels` and every event carries its guildId.
import { EmbedBuilder, AuditLogEvent } from 'discord.js';
import { appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAILED_FILE = join(__dirname, 'failed-events.jsonl');

const DEFAULT_MAX = { moderation: 200, member: 120, server: 100, voice: 60, message: 100 };
const DEFAULT_TIMING = { debounceMs: 2500, batchMs: 3500, suppressMs: 10000 };
const MOD_FLUSH_RETRIES = 2;

export class EventPipeline {
  constructor({ client, channels, getAudit, sendEmbed, log, err, maxLengths = {}, timing = {} }) {
    this.client = client;
    this.CH = channels;
    this.getAudit = getAudit;
    this._sendEmbed = sendEmbed;
    this.log = log;
    this.err = err;
    this.maxLengths = { ...DEFAULT_MAX, ...maxLengths };
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.queues = { moderation: [], member: [], server: [], voice: [], message: [] };
    this.priority = ['moderation', 'member', 'server', 'voice', 'message'];
    this.weights = { moderation: 4, member: 2, server: 2, voice: 1, message: 1 };
    this.processing = false;
    this.scheduled = false;
    // per-channel circuit: channelId -> {failures, openUntil}
    this.circuits = new Map();
    for (const id of Object.values(channels)) this.circuits.set(id, { failures: 0, openUntil: 0 });
    this.debounce = new Map();
    this.suppressed = new Map();
    setInterval(() => {
      const n = Date.now();
      for (const [k, t] of this.debounce) if (n - t > 15000) this.debounce.delete(k);
      for (const [k, exp] of this.suppressed) if (n > exp) this.suppressed.delete(k);
    }, 30000);
    this.pendingMod = [];
    this.modTimer = null;
    // metrics
    this.metrics = {
      queueDepth: { moderation: 0, member: 0, server: 0, voice: 0, message: 0 },
      oldestAgeMs: { moderation: 0, member: 0, server: 0, voice: 0, message: 0 },
      sent: { moderation: 0, member: 0, server: 0, voice: 0, message: 0 },
      failed: { moderation: 0, member: 0, server: 0, voice: 0, message: 0 },
      retried: { moderation: 0, member: 0, server: 0, voice: 0, message: 0 },
      dropped: { moderation: 0, member: 0, server: 0, voice: 0, message: 0 },
      circuitState: {},
    };
    this._updateMetrics();
    // fallback polling (safety) + event-driven via enqueue
    setInterval(() => { if (!this.processing && this.hasPending()) this.schedule(); }, 1000);
  }

  hasPending() { return this.priority.some(c => this.queues[c].length > 0) || this.pendingMod.length > 0; }

  shouldFire(key, ms = this.timing.debounceMs) {
    const last = this.debounce.get(key) || 0;
    if (Date.now() - last < ms) return false;
    this.debounce.set(key, Date.now());
    return true;
  }
  suppress(id, ms = this.timing.suppressMs) { this.suppressed.set(id, Date.now() + ms); setTimeout(() => this.suppressed.delete(id), ms); }
  isSuppressed(id) { const exp = this.suppressed.get(id); return exp && exp > Date.now(); }

  getCircuit(channelId) {
    if (!this.circuits.has(channelId)) this.circuits.set(channelId, { failures: 0, openUntil: 0 });
    return this.circuits.get(channelId);
  }
  recordCircuit(channelId, ok) {
    const c = this.getCircuit(channelId);
    if (ok) { c.failures = 0; c.openUntil = 0; return; }
    c.failures++;
    if (c.failures >= 3) c.openUntil = Date.now() + 15000;
  }
  isCircuitOpen(channelId) { return Date.now() < this.getCircuit(channelId).openUntil; }

  _updateMetrics() {
    for (const cat of this.priority) {
      this.metrics.queueDepth[cat] = this.queues[cat].length;
      const oldest = this.queues[cat][0];
      this.metrics.oldestAgeMs[cat] = oldest ? Date.now() - (oldest._ts || Date.now()) : 0;
      const chId = this.getChannelForCategory(cat, this.queues[cat][0]);
      const circ = chId ? this.getCircuit(chId) : null;
      this.metrics.circuitState[cat] = circ ? (Date.now() < circ.openUntil ? `open:${Math.round((circ.openUntil-Date.now())/1000)}s` : 'closed') : 'closed';
    }
  }
  getMetrics() {
    this._updateMetrics();
    return JSON.parse(JSON.stringify(this.metrics));
  }

  sanitizeForFailed(ev) {
    const copy = { ...ev };
    delete copy.thumb;
    if (copy.content) copy.content = String(copy.content).slice(0, 500);
    if (copy.before) copy.before = String(copy.before).slice(0, 300);
    if (copy.after) copy.after = String(copy.after).slice(0, 300);
    // never log token
    return copy;
  }
  writeFailed(category, event, reason) {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), category, reason, event: this.sanitizeForFailed(event) });
      appendFileSync(FAILED_FILE, line + '\n');
    } catch {}
  }

  enqueue(category, event) {
    if (!this.queues[category]) category = 'message';
    event._ts = event._ts || Date.now();
    event._enqueuedAt = Date.now();
    const max = this.maxLengths[category];
    if (this.queues[category].length >= max) {
      if (category === 'moderation') {
        // never drop moderation — persist overflow to failed file and keep in queue (expand temporarily)
        this.writeFailed(category, event, 'queue_overflow_moderation_persisted');
        this.metrics.failed[category]++;
        // still enqueue but log overflow; to prevent unbounded growth, we allow up to max*1.5
        if (this.queues[category].length >= max * 1.5) {
          this.log(`moderation overflow hard limit ${max*1.5} — still persisting to file`);
        }
      } else if (category === 'message' || category === 'voice') {
        // drop oldest, count dropped (merge/drop under pressure)
        const dropped = this.queues[category].shift();
        this.metrics.dropped[category]++;
        this.log(`dropped ${category} oldest event due to overflow (max ${max})`);
      } else {
        // member/server: drop oldest with counter
        this.queues[category].shift();
        this.metrics.dropped[category]++;
        this.log(`dropped ${category} event overflow`);
      }
    }
    // immediate suppression for bans so leave event is ignored even if queued earlier
    if (category === 'moderation' && (event.type === 'ban' || event.type === 'mute')) this.suppress(event.targetId, 12000);
    this.queues[category].push(event);
    this._updateMetrics();
    this.schedule();
  }

  schedule() {
    if (this.scheduled || this.processing) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.process(); });
  }

  async process() {
    if (this.processing) return;
    this.processing = true;
    try {
      let rounds = 0;
      const maxRounds = 20; // prevent infinite loop
      while (this.hasPending() && rounds < maxRounds) {
        rounds++;
        let madeProgress = false;
        for (const cat of this.priority) {
          const weight = this.weights[cat] || 1;
          let count = 0;
          while (count < weight && this.queues[cat].length) {
            // per-channel circuit check before handling
            const chId = this.getChannelForCategory(cat, this.queues[cat][0]);
            if (chId && this.isCircuitOpen(chId)) {
              this.log(`circuit open for ${cat} channel ${String(chId).slice(-4)} — deferring`);
              break; // skip this category this round, let circuit cool
            }
            const ev = this.queues[cat].shift();
            this._updateMetrics();
            try {
              await this.handleByCategory(cat, ev);
              this.metrics.sent[cat]++;
              this.recordCircuit(chId, true);
            } catch (e) {
              this.err(`pipeline ${cat}`, e.message);
              this.metrics.failed[cat]++;
              this.recordCircuit(chId, false);
              // moderation: bounded retries (max 2), then persist to failed-events.
              // Bounded counter (not boolean) prevents unshift-forever FIFO starvation.
              if (cat === 'moderation') {
                const r = ev._retries || 0;
                if (r < MOD_FLUSH_RETRIES) {
                  ev._retries = r + 1;
                  this.metrics.retried[cat]++;
                  this.queues[cat].push(ev); // push (not unshift): keeps FIFO, retried event goes after pending ones
                } else {
                  this.writeFailed(cat, ev, `retries exhausted (${r}): ${e.message}`);
                }
              }
            }
            count++;
            madeProgress = true;
            // rate limiter: 350ms between sends
            await new Promise(r => setTimeout(r, 350));
            if (this.isCircuitOpen(chId)) break;
          }
        }
        if (!madeProgress) break;
        // if still pending, continue weighted round robin
      }
    } finally {
      this.processing = false;
      this._updateMetrics();
      if (this.hasPending()) this.schedule();
    }
  }

  getChannelForCategory(cat, ev) {
    if (!ev) return null;
    if (cat === 'moderation') return this.CH.MOD_LOG;
    if (cat === 'member') {
      if (ev.type === 'join') return this.CH.JOIN_LEAVE;
      return this.CH.MEMBER;
    }
    if (cat === 'server') return this.CH.SERVER;
    if (cat === 'voice') return this.CH.VOICE_LOG;
    if (cat === 'message') return this.CH.MESSAGE;
    return null;
  }

  async handleByCategory(cat, ev) {
    switch (cat) {
      case 'moderation': await this.handleModeration(ev); break;
      case 'member': await this.handleMember(ev); break;
      case 'server': await this.handleServer(ev); break;
      case 'voice': await this.handleVoice(ev); break;
      case 'message': await this.handleMessage(ev); break;
    }
  }
  // ——— moderation ———
  async handleModeration(ev) {
    const guild = await this.client.guilds.fetch(ev.guildId).catch(()=>null);
    if (!guild) throw new Error('guild fetch failed');
    if (ev.type === 'leaveOrKick') {
      if (this.isSuppressed(ev.targetId)) { this.log('leave suppressed (ban)', ev.targetTag); return; }
      const audit = await this.getAudit(guild, AuditLogEvent.MemberKick, ev.targetId);
      if (audit) {
        this.suppress(ev.targetId, 12000);
        this.queueMod({ title: '🔨 طرد عضو', label: 'طرد', color: 0xed4245, thumb: ev.thumb, targetId: ev.targetId, targetTag: ev.targetTag, actor: audit.executor, reason: audit.reason, guildId: ev.guildId });
        return;
      }
      const em = new EmbedBuilder().setColor(0x99aab5).setTimestamp().setAuthor({ name: '📤 خروج عضو' }).setThumbnail(ev.thumb || null)
        .addFields(
          { name: '👤 العضو', value: `<@${ev.targetId}> (\`${ev.targetTag}\` — \`${ev.targetId}\`)`, inline: false },
          { name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true }
        );
      await this._sendEmbed(this.CH.JOIN_LEAVE, em);
      return;
    }
    if (ev.type === 'ban') {
      const audit = await this.getAudit(guild, AuditLogEvent.MemberBanAdd, ev.targetId);
      this.queueMod({ title: '🔨 حظر عضو', label: 'حظر', color: 0xed4245, thumb: ev.thumb, targetId: ev.targetId, targetTag: ev.targetTag, actor: audit?.executor || null, reason: audit?.reason || null, guildId: ev.guildId });
      return;
    }
    if (ev.type === 'unban') {
      const audit = await this.getAudit(guild, AuditLogEvent.MemberBanRemove, ev.targetId);
      this.queueMod({ title: '🔓 فك حظر', label: 'فك حظر', color: 0x57f287, thumb: ev.thumb, targetId: ev.targetId, targetTag: ev.targetTag, actor: audit?.executor || null, reason: audit?.reason || null, guildId: ev.guildId });
      return;
    }
    if (ev.type === 'mute' || ev.type === 'unmute') {
      const isMute = ev.type === 'mute';
      const audit = await this.getAudit(guild, AuditLogEvent.MemberUpdate, ev.targetId);
      this.queueMod({ title: isMute ? '🔇 إسكات عضو' : '🔊 فك إسكات', label: isMute ? 'إسكات' : 'فك إسكات', color: isMute ? 0xed4245 : 0x57f287, thumb: ev.thumb, targetId: ev.targetId, targetTag: ev.targetTag, actor: audit?.executor || null, reason: audit?.reason || (isMute && ev.until ? `حتى <t:${Math.floor(ev.until/1000)}:R>` : null), guildId: ev.guildId });
      return;
    }
  }
  queueMod(entry) {
    this.pendingMod.push(entry);
    entry._ts = Date.now();
    if (!this.modTimer) this.modTimer = setTimeout(() => this.flushMod(), this.timing.batchMs);
  }
  async flushMod() {
    const batch = [...this.pendingMod]; this.pendingMod = []; this.modTimer = null;
    if (!batch.length) return;
    const chId = this.CH.MOD_LOG;
    if (this.isCircuitOpen(chId)) {
      this.log('mod flush deferred circuit open');
      this.pendingMod.unshift(...batch);
      this.modTimer = setTimeout(() => this.flushMod(), this.timing.batchMs);
      return;
    }
    const guildId = batch[0].guildId;
    if (!guildId) {
      // never send to an unknown guild — persist instead of guessing
      for (const b of batch) this.writeFailed('moderation', b, 'missing guildId on event');
      this.metrics.failed.moderation += batch.length;
      return;
    }
    try {
      const g = await this.client.guilds.fetch(guildId);
      const ch = await g.channels.fetch(chId);
      if (!ch?.isTextBased()) throw new Error('mod channel not text');
      if (batch.length === 1) {
        const b = batch[0];
        const em = this.buildModEmbed(b);
        await ch.send({ embeds: [em] });
      } else {
        const first = batch[0];
        const sameActor = batch.every(x => x.actor?.id === first.actor?.id);
        const em = new EmbedBuilder().setColor(first.color).setTimestamp().setAuthor({ name: `🛡️ إجراء إداري مجمّع — ${batch.length} أهداف` }).setDescription(batch.map((b,i)=> `${i+1}. **${b.targetTag}** (<@${b.targetId}>) — ${b.label}`).join('\n').slice(0,3500));
        if (first.thumb) em.setThumbnail(first.thumb);
        if (sameActor && first.actor) em.addFields({ name: '🛡️ المنفذ', value: `<@${first.actor.id}>`, inline: true });
        if (first.reason) em.addFields({ name: '📝 السبب', value: first.reason.slice(0,600), inline: true });
        em.addFields({ name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true });
        await ch.send({ embeds: [em] });
      }
      this.log(`pipeline flushed mod batch: ${batch.length}`);
      this.recordCircuit(chId, true);
      this.metrics.sent.moderation += batch.length;
    } catch (e) {
      this.err('flushMod', e.message);
      this.recordCircuit(chId, false);
      this.metrics.failed.moderation += batch.length;
      // Bounded batch retry with backoff (mirrors process()-level moderation
      // retries); after MOD_FLUSH_RETRIES the batch is persisted, never dropped.
      const retries = batch[0]._retries || 0;
      if (retries < MOD_FLUSH_RETRIES) {
        for (const b of batch) b._retries = retries + 1;
        this.metrics.retried.moderation += batch.length;
        this.pendingMod.unshift(...batch);
        this.modTimer = setTimeout(() => this.flushMod(), 1500 * (retries + 1));
        this.log(`mod flush retry ${retries + 1}/${MOD_FLUSH_RETRIES} in ${1500 * (retries + 1)}ms`);
      } else {
        for (const b of batch) this.writeFailed('moderation', b, `retries exhausted (${retries}): ${e.message}`);
        this.err(`mod batch persisted to failed-events after ${retries} retries`, e.message);
      }
    }
  }
  buildModEmbed(b) {
    const e = new EmbedBuilder().setColor(b.color).setTimestamp();
    if (b.title) e.setAuthor({ name: b.title });
    if (b.thumb) e.setThumbnail(b.thumb);
    e.addFields({ name: '👤 المستهدف', value: `<@${b.targetId}> (\`${b.targetTag}\` — \`${b.targetId}\`)`, inline: false });
    if (b.actor) e.addFields({ name: '🛡️ المنفذ', value: `<@${b.actor.id}> (\`${b.actor.tag}\`)`, inline: true });
    else e.addFields({ name: '🛡️ المنفذ', value: '`غير معروف / النظام`', inline: true });
    e.addFields({ name: '📝 السبب', value: b.reason ? b.reason.slice(0,800) : '`لا يوجد سبب`', inline: true });
    e.addFields({ name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true });
    return e;
  }
  // ——— member ———
  async handleMember(ev) {
    if (ev.type === 'join') {
      const em = new EmbedBuilder().setColor(0x57f287).setTimestamp().setAuthor({ name: '📥 دخول عضو جديد' }).setThumbnail(ev.thumb || null)
        .addFields(
          { name: '👤 العضو', value: `<@${ev.targetId}> (\`${ev.targetTag}\` — \`${ev.targetId}\`)`, inline: false },
          { name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true }
        );
      await this._sendEmbed(this.CH.JOIN_LEAVE, em);
      return;
    }
    if (this.isSuppressed(ev.targetId)) { this.log('member suppressed', ev.targetTag); return; }
    if (!this.shouldFire(`mupd-${ev.targetId}`, 2500)) { this.log('member debounce', ev.targetTag); return; }
    if (ev.type === 'roleAdd' || ev.type === 'roleRemove') {
      const em = new EmbedBuilder().setColor(ev.color).setTimestamp().setThumbnail(ev.thumb || null).setAuthor({ name: ev.title })
        .addFields(
          { name: '👤 العضو', value: `<@${ev.targetId}> (\`${ev.targetTag}\`)`, inline: false },
          { name: '🎭 الرتب', value: ev.roles.map(r=>`\`${r}\``).join(', ').slice(0,900), inline: false },
          { name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true }
        );
      await this._sendEmbed(this.CH.MEMBER, em);
      return;
    }
    if (ev.type === 'nick') {
      const em = new EmbedBuilder().setColor(0xfee75c).setTimestamp().setThumbnail(ev.thumb || null).setAuthor({ name: '✏️ تغيير كنية' })
        .addFields(
          { name: '👤 العضو', value: `<@${ev.targetId}>`, inline: true },
          { name: '📝 من → إلى', value: `\`${ev.oldNick||'(بلا)'}\` → \`${ev.newNick||'(بلا)'}\``, inline: true },
          { name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true }
        );
      await this._sendEmbed(this.CH.MEMBER, em);
    }
  }
  // ——— server ———
  async handleServer(ev) {
    if (ev.role?.managed || ev.role?.tags?.botId) return;
    if (ev.type === 'roleUpdate' && !this.shouldFire(`rupdate-${ev.role?.id || ev.newR?.id}`, 2500)) return;
    let em;
    if (ev.type === 'roleCreate') {
      const audit = await this.getAudit(await this.client.guilds.fetch(ev.guildId), AuditLogEvent.RoleCreate, ev.role.id);
      em = new EmbedBuilder().setColor(0x57f287).setTimestamp().setAuthor({ name: '➕ إنشاء رتبة' })
        .addFields(
          { name: '🎭 الرتبة', value: `\`${ev.role.name}\` (<@&${ev.role.id}>)`, inline: true },
          { name: '🛡️ المنفذ', value: audit?.executor ? `<@${audit.executor.id}>` : '`النظام`', inline: true },
          { name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true }
        );
    } else if (ev.type === 'roleDelete') {
      const audit = await this.getAudit(await this.client.guilds.fetch(ev.guildId), AuditLogEvent.RoleDelete, ev.role.id);
      em = new EmbedBuilder().setColor(0xed4245).setTimestamp().setAuthor({ name: '➖ حذف رتبة' })
        .addFields(
          { name: '🎭 الرتبة', value: `\`${ev.role.name}\``, inline: true },
          { name: '🛡️ المنفذ', value: audit?.executor ? `<@${audit.executor.id}>` : '`غير معروف`', inline: true },
          { name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true }
        );
      if (audit?.reason) em.addFields({ name: '📝 السبب', value: audit.reason.slice(0,600), inline: true });
    } else if (ev.type === 'roleUpdate') {
      const audit = await this.getAudit(await this.client.guilds.fetch(ev.guildId), AuditLogEvent.RoleUpdate, ev.newR.id);
      em = new EmbedBuilder().setColor(0xfee75c).setTimestamp().setAuthor({ name: '✏️ تعديل رتبة' })
        .addFields(
          { name: '🎭 من → إلى', value: `\`${ev.oldR.name}\` → \`${ev.newR.name}\``, inline: true },
          { name: '🛡️ المنفذ', value: audit?.executor ? `<@${audit.executor.id}>` : '`غير معروف`', inline: true },
          { name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true }
        );
    } else if (ev.type === 'channelCreate') {
      const audit = await this.getAudit(await this.client.guilds.fetch(ev.guildId), AuditLogEvent.ChannelCreate, ev.channel.id);
      em = new EmbedBuilder().setColor(0x57f287).setTimestamp().setAuthor({ name: '➕ إنشاء قناة' })
        .addFields(
          { name: '💬 القناة', value: `<#${ev.channel.id}> (\`${ev.channel.name}\`)`, inline: true },
          { name: '🛡️ المنفذ', value: audit?.executor ? `<@${audit.executor.id}>` : '`النظام`', inline: true },
          { name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true }
        );
    } else if (ev.type === 'channelDelete') {
      const audit = await this.getAudit(await this.client.guilds.fetch(ev.guildId), AuditLogEvent.ChannelDelete, ev.channel.id);
      em = new EmbedBuilder().setColor(0xed4245).setTimestamp().setAuthor({ name: '➖ حذف قناة' })
        .addFields(
          { name: '💬 القناة', value: `\`${ev.channel.name}\``, inline: true },
          { name: '🛡️ المنفذ', value: audit?.executor ? `<@${audit.executor.id}>` : '`غير معروف`', inline: true },
          { name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true }
        );
      if (audit?.reason) em.addFields({ name: '📝 السبب', value: audit.reason.slice(0,600), inline: true });
    }
    if (em) await this._sendEmbed(this.CH.SERVER, em);
  }
  // ——— voice ———
  async handleVoice(ev) {
    const key = `voice-${ev.targetId}-${ev.oldChannel||'null'}-${ev.newChannel||'null'}`;
    if (!this.shouldFire(key, 2500)) { this.log('voice debounce', ev.targetTag); return; }
    const em = new EmbedBuilder().setColor(ev.color).setTimestamp().setAuthor({ name: ev.title }).setDescription(ev.desc);
    if (ev.thumb) em.setThumbnail(ev.thumb);
    if (ev.fields) { for (const f of ev.fields) em.addFields(f); }
    else {
      if (ev.oldChannel && !ev.newChannel) em.addFields({ name: '👤 العضو', value: `<@${ev.targetId}>`, inline: true }, { name: '🔊 الروم', value: `\`${ev.oldName || ev.oldChannel}\``, inline: true }, { name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true });
      else if (!ev.oldChannel && ev.newChannel) em.addFields({ name: '👤 العضو', value: `<@${ev.targetId}>`, inline: true }, { name: '🔊 الروم', value: `<#${ev.newChannel}>`, inline: true }, { name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true });
      else if (ev.oldChannel && ev.newChannel) em.addFields({ name: '👤 العضو', value: `<@${ev.targetId}>`, inline: true }, { name: '🔊 من → إلى', value: `\`${ev.oldName}\` → \`${ev.newName}\``, inline: true }, { name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true });
    }
    await this._sendEmbed(this.CH.VOICE_LOG, em);
  }
  // ——— message ———
  async handleMessage(ev) {
    const key = ev.type === 'edit' ? `msgedit-${ev.id}` : `msgdel-${ev.id}`;
    if (!this.shouldFire(key, 5000)) { this.log('message debounce', key); return; }
    let em;
    if (ev.type === 'edit') {
      em = new EmbedBuilder().setColor(0xfee75c).setTimestamp().setAuthor({ name: '📝 رسالة معدّلة', iconURL: ev.thumb || undefined }).setThumbnail(ev.thumb || null)
        .addFields(
          { name: '👤 العضو', value: `<@${ev.author.id}> (\`${ev.author.tag}\`)`, inline: true },
          { name: '💬 الروم', value: `<#${ev.channelId}>`, inline: true },
          { name: '🔗 الرسالة', value: `[انتقل](https://discord.com/channels/${ev.guildId}/${ev.channelId}/${ev.id})`, inline: true },
          { name: 'قبل', value: (ev.before||'(فارغ)').slice(0,800) || '(فارغ)', inline: false },
          { name: 'بعد', value: (ev.after||'(فارغ)').slice(0,800) || '(فارغ)', inline: false },
          { name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true }
        );
    } else {
      em = new EmbedBuilder().setColor(0xed4245).setTimestamp().setAuthor({ name: '🗑️ رسالة محذوفة', iconURL: ev.author?.displayAvatarURL?.() || undefined })
        .addFields(
          { name: '👤 العضو', value: ev.author ? `<@${ev.author.id}> (\`${ev.author.tag}\`)` : '`unknown`', inline: true },
          { name: '💬 الروم', value: `<#${ev.channelId}>`, inline: true },
          { name: '📝 المحتوى', value: (ev.content||'(ملف/تضمين)').slice(0,900), inline: false },
          { name: '🕒 الوقت', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true }
        );
      if (ev.attachments) em.addFields({ name: '📎 المرفقات', value: `${ev.attachments} ملف`, inline: true });
      if (ev.thumb) em.setThumbnail(ev.thumb);
    }
    await this._sendEmbed(this.CH.MESSAGE, em);
  }
}
