# AL AI Bot Runtime (v3.0.0 — Unified Runtime)

Production-hardened Discord **unified runtime** — single gateway, single pipeline, single config, with MCP as a secure control layer.

- **Presence:** Always-online gateway with real websocket health (`health-state.json`) and single-instance lock (`.bot.lock`).
- **Pipeline:** 6-channel logging (JOIN_LEAVE/VOICE/MOD/MESSAGE/MEMBER/SERVER) via 5 bounded queues, audit resolution, and per-channel circuit — active when `control-plane.json` + `GUILD_ID` are present, otherwise the runtime stays in zero-intent presence.
- **Control:** MCP (integration-adapter on `127.0.0.1:3415`, HMAC + dedupe + rate limit) exposes 6 tools (`getStatus/diagnose/readLogs/suggestConfig/stageConfig/listChannels`) as thin interfaces to the runtime services — no duplicated Discord logic.

This repository contains the runtime (`gateway`, `event-pipeline`, `bot-supervisor`), the control plane (`lib/config`, `control-plane.json`), the MCP layer (`integration-adapter`), and shared services (`lib/discord`, `lib/platform`, `lib/atomic`).

## Architecture (Unified)

```
.env (DISCORD_TOKEN [+ GUILD_ID + ADAPTER_TOKEN])
  + control-plane.json (6 channels, timings, permissions, autorole)
    → Single Gateway Runtime (gateway.mjs — unified)
        → presence: health watcher + .bot.lock
        → pipeline (when configured): 5 queues → 6 channels
    → Discord Gateway

AI Agent → MCP (integration-adapter, HMAC, 127.0.0.1:3415)
           → lib/discord (single Discord service) → Discord REST/Gateway
           → lib/config + config-manager (validated apply)
           → health-state / logs
```

## Prerequisites
- **Windows 10/11 or Linux** (macOS untested); containers via the included Dockerfile
- **Node.js 22 or 24 LTS** (=24 recommended; Node 20 reached EOL in April 2026)
- A Discord bot application. **No privileged intents required in minimal mode** - zero intents. Full mode uses `Guilds, GuildMembers, GuildMessages, GuildVoiceStates, MessageContent, GuildModeration` (GuildModeration is privileged for ban events).
- Privileged intents note (June 2026 policy): apps reaching **10,000 unique users** must apply for intent access with an annual review - a single-guild bot stays under the threshold and only needs the portal toggles enabled.

## Tech Stack

| Layer | Technology | Version | Purpose | Best Practice |
|---|---|---|---|---|
| **Runtime** | `Node.js` | `22/24 LTS` | Gateway + supervisor + pipeline (ESM) | استخدم `node --check` قبل كل push؛ `npm ci` في الإنتاج |
| **Discord** | `discord.js` | `^14.27` | Gateway intents + REST + audit logs | استخدم `lib/discord.mjs` فقط — لا تستدع `fetch` مباشرة |
| **Validation** | `zod` | `^4.4.3` | `control-plane.json` schema | كل config يمر عبر `controlPlaneSchema.safeParse` |
| **Env** | `dotenv` | `^17.2` | `.env` عبر `lib/env.mjs` | لا تقرأ `process.env` يدوياً — استخدم `readEnv/readGuildId` |
| **Files** | `lib/atomic` | — | كتابة ذرية `*.tmp.* → rename` | كل كتابة JSON عبر `atomicWriteJson` |
| **Platform** | `lib/platform` | — | `verifyProcess/ spawnDetachedNode` | استدع `verifyProcess` قبل قتل أي `pid` |
| **Health** | `health-state.mjs` | — | `health-state.json` كل 20s | اقرأ فقط `health-state.json` — لا تتصل بـ Discord للفحص |
| **Logs** | `log-rotation` | — | تدوير `10MB×14` | لا تكتب logs خارج `supervisor.log/gateway-out.log` |
| **Service** | `lib/discord` | — | خدمة Discord الموحّدة (REST) | كل تفاعل مع Discord عبر هذه الطبقة — تمنع التكرار |

## Ranks & Permissions — السياق وأفضل ممارسة

**التسلسل الهرمي الحقيقي (Baran's server — 118 رتبة):**

| المستوى | الرتبة | ID | الصلاحية | الاستخدام |
|---|---|---|---|---|
| 122 | `AL AI` (البوت) | `1540966100747944020` | `Administrator (8)` | يجب أن تبقى أعلى من `Member` (111) ليستطيع إسنادها |
| 121 | `👑 Owner` | `1540977894728142888` | إدارة كاملة | `controlPlaneAllowedRoles` — فقط هؤلاء يطبقون `stageConfig` |
| 120 | `Co Owner` | `1540977897077080165` | إدارة كاملة | ثانوي للـ Owner |
| 119 | `Head Admin` | `1540977899467968572` | إدارة | إشراف عام |
| 118 | `Admin` | `1540977901871042580` | إدارة |  |
| 111 | `Member` | `1540977916387786779` | `2147863552` | **Autorole الافتراضي** — تُسند تلقائياً عند `GuildMemberAdd` إذا `autorole.enabled=true` |
| 106-26 | `Level 100` → `Level 1` | متسلسلة | مستويات نشاط | لا تلمسها يدوياً — تُدار عبر بوت مستويات |
| 0 | `@everyone` | `1523473815555018782` | افتراضية | لا تعطها صلاحيات حساسة |

**أفضل ممارسة للرتب (Best Practice):**

1. **اعزل رتبة البوت:** `AL AI` أعلى من `Member` بـ 11 مستوى — لا تضع أي رتبة فوقها إلا `Owner`.
2. **استخدم `controlPlaneAllowedRoles` فقط للتحكم في `MCP`:** `["👑 Owner","Co Owner"]` — لا تضع `Admin` هنا إلا اذا أردت توسيع التحكم.
3. **Autorole:** اترك `autorole.memberRoleName="Member"` — البوت يبحث عبر `guild.roles.cache.find(r=>r.name==="Member")` ثم `member.roles.add(role)` — إذا لم يجدها لا يفشل.
4. **لا تكرر رتب Level يدوياً:** رتب `Level X` تُدار تلقائياً — أي تعديل يدوي يكسر التدرج.
5. **تحقق قبل كل عملية رتبة:** استخدم `getGuildRoles` من `lib/discord` للتحقق أن `roleId` موجود قبل `addRoleToMember`/`removeRoleFromMember`.
6. **Audit:** كل `roleAdd/roleRemove/nick` يُسجل في `MEMBER` log مع `color` و `author` — راجع `MEMBER` channel قبل أي تغيير واسع.

## Configuration

| Setting | File | Required | Notes | Best Practice |
|---|---|---|---|---|
| `DISCORD_TOKEN` | `.env` | **always** | bot token | لا تشاركه أبداً — ضعه في `Pterodactyl Variable` كـ secret |
| `GUILD_ID` | `.env` | full mode only | guild ID 17-20 | استخدم `GUILD_ID` الجديد (alias القديم `OMNICORD_GUILD` ما زال يعمل) |
| `ADAPTER_TOKEN` | `.env` | adapter only | HMAC secret | ولّده بـ `randomBytes(32).hex` ودوّره عند التسريب |
| 6 channels + timings + autorole + permissions | `control-plane.json` | full mode only | نسخ من `control-plane.example.json` | عدّل فقط `channels` و `ownerId` و `memberRoleName` — اترك `gateway/supervisor` كما هي. **Hot-reload:** التعديلات تُلتقط تلقائياً خلال ~1 ثانية بدون restart (تغيير `GUILD_ID` يتطلب restart) |
| `HEALTH_INTERVAL_MS` etc. | `.env` | optional | clamped | لا تغيرها إلا اذا كان السيرفر ضعيف (الافتراضي 20s/10MB×14 مثالي) |

**قاعدة ذهبية:** كل تفاعل مع Discord (قنوات/رتب/أعضاء/رسائل) يجب أن يمر عبر `lib/discord.mjs` — هذا يضمن `multi-guild` آمن (كل دالة تأخذ `guildId`), ويمنع تكرار `fetch`, ويوحّد التحقق من `snowflake`.

## Quick start

### Minimal presence (always-online, zero intents)
```powershell
npm install
copy .env.example .env
# edit .env -> DISCORD_TOKEN only
node index.js
# or via supervisor (enforces one Gateway):
node bot-supervisor.mjs --mode=gateway --action=start
node bot-supervisor.mjs --action=status
```

### Full logging + autorole

```powershell
# 1) install + minimal env
npm install
copy .env.example .env
# edit .env -> DISCORD_TOKEN, GUILD_ID, ADAPTER_TOKEN

# 2) enable full mode: copy and edit control-plane
copy control-plane.example.json control-plane.json
# edit control-plane.json -> 6 channel IDs, ownerId, autorole.memberRoleName

# 3) validate config (optional but recommended)
npm run config:validate
# or: node config-manager.mjs validate

# 4) run - gateway auto-detects full mode and enables pipeline
node index.js
# or via supervisor:
node bot-supervisor.mjs --mode=gateway --action=start

# 5) adapter (optional, for suggest/apply/listChannels)
node integration-adapter.mjs
# listening on 127.0.0.1:3415 - HMAC enforced
```

## Deployment

**Platform support:** Windows - fully exercised (live spawn/verify/kill). Linux/POSIX - via `lib/platform.mjs` (`/proc` + signal probes). Docker - `Dockerfile` provided (node is PID 1, SIGTERM-safe). Pterodactyl - use `node /home/container/index.js` as startup command (8 chars, under 16-char MAIN_FILE cap).

### Docker
```bash
docker build -t al-ai-bot .
docker run -d --name al-bot -e DISCORD_TOKEN=... -e GUILD_ID=... al-ai-bot
# mount control-plane.json as volume for full mode:
# -v ./control-plane.json:/app/control-plane.json:ro
```

## Single Gateway - how it is enforced

`.bot.lock` (atomic `wx` acquire, `pid/nonce/mode/processCommand/schemaVersion`) persists for the entire Gateway lifetime. A second gateway exits with code 2 while the lock holder is verified alive, and with code 4 when process verification is *unknown* - an unknown lock is never deleted and never bypassed (fail-safe). PID reuse is guarded by command-line verification (`lib/platform.mjs`: Windows ? CIM/tasklist; Linux ? `/proc/<pid>/cmdline`).

## Event Pipeline (full mode)

- **5 bounded queues** with weights: `moderation(4) > member(2) > server(2) > voice(1) > message(1)` - fair weighted round-robin, 350ms between sends.
- **Per-channel circuit breaker:** 3 failures ? open 15s, per-channel (JOIN_LEAVE vs MOD_LOG vs etc. are independent).
- **Debounce / suppress:** `debounceMs` (member/role/voice), `debounceMs*2` (message), `max(suppressMs, AUDIT_WINDOW_MS)` for bans/mutes - prevents raid floods.
- **Never drop moderation:** overflow at `max` is persisted to `failed-events.jsonl` but kept queued; at `max*1.5` it is persisted and *not* queued (hard cap) - memory stays bounded, nothing lost.
- **Batched moderation flush:** `batchMs` window collects moderation events, sends as single or aggregated embed with retry (`MOD_FLUSH_RETRIES=2` with backoff) before persisting.
- **Graceful shutdown:** `pipeline.persistAllPending(reason)` drains every queue + `pendingMod` to `failed-events.jsonl` before client destroy (SIGTERM/SIGINT).

Channels (full mode, from control-plane.json):
- `JOIN_LEAVE` - joins + clean leaves (non-kick)
- `VOICE_LOG` - join/leave/move
- `MOD_LOG` - bans/mutes/kicks (batched)
- `MESSAGE` - edits/deletes (lowest priority)
- `MEMBER` - role adds/removes, nick changes
- `SERVER` - role/channel create/delete/update

## Health reporting

`health-state.json` (written every `HEALTH_INTERVAL_MS`, default 20s) contains: real websocket state (`connected` only when `client.ws.status` is Ready, otherwise `connecting/reconnecting/idle/nearly/disconnected`), uptime, memory, pipeline metrics (when full mode, otherwise null), last event type, last error. The adapter's `getStatus` reads this file plus `bot-state.json`/`.bot.lock` directly - no subprocess spawn, no stale REST data; snapshot age is reported alongside.

## Integration adapter (local only, HMAC + dedupe + rate limit)

- `POST http://127.0.0.1:3415/adapter/request` - mandatory headers: `X-Adapter-Token`, `X-Timestamp`, `X-Nonce`, `X-Signature: HMAC-SHA256(timestamp.nonce.body, ADAPTER_TOKEN)`
- **Allowlist:** `getStatus, diagnose, readLogs` (always) + `suggestConfig, stageConfig, listChannels` (full mode, via `lib/discord` service)
- **Blocked:** `execOS, runShell, changeToken, updateSecrets, modifyConfigWithoutValidation, ...` - exact-key blocklist plus deep scan for `__proto__/constructor/token/ownerId` etc.
- `maxBody 64KB`, `timeout 5s`, post-auth rate limit (60/min per IP, separate brute-force bucket for failed auth), persistent `requestId`/`nonce` dedupe (24h/10min)
- `suggestConfig` - validates partial update and returns diff preview vs current `control-plane.json`
- `stageConfig` - validates, merges with existing file if partial, stages to `control-plane.staged.json` (then run `node config-manager.mjs apply` for resource validation + health check + atomic apply or rollback)
- `listChannels` - fetches guild channels via Discord REST (requires `DISCORD_TOKEN` + `GUILD_ID`)

### Local diagnostics endpoints

Unauthenticated (safe: loopback-only, health-state contains no secrets):

| Endpoint | Purpose |
|---|---|
| `GET /health` | JSON snapshot: gateway state, uptime, memory, pipeline metrics, last error |
| `GET /metrics` | Prometheus text format (`al_bot_*`: up, queue depths, p95 wait, sent/skipped/failed counters) |

By default the adapter listens on TCP `127.0.0.1:$ADAPTER_PORT` (default 3415). On POSIX you can set `ADAPTER_SOCKET=/path/to/sock` to bind a Unix domain socket (mode 0600) instead - filesystem permissions replace localhost-as-trust.

## Tests

```powershell
npm test          # everything: static checks, config, platform, pipeline, adapter suites
npm run check     # syntax + JSON + .env.example coverage + control-plane example validation
node test-platform.mjs
node test-pipeline.mjs
node test-config.mjs
node test-adapter-hardened.mjs   # needs adapter running (or npm test)
node test-adapter-validation.mjs # validates blocked keys, pollution vectors
```

## Replaying failed events

Events persisted to `failed-events.jsonl` (overflow, retries exhausted,
shutdown drain) can be re-sent as digest embeds:

```powershell
npm run replay                          # dry-run: shows counts per category
node replay-failed.mjs --archive        # sends digests, archives the file on full success
```

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci && npm run lint && npm run check && npm test`
on every push/PR across Node 22 + 24 (plus a Windows job for the platform layer).
A pre-commit hook (`tools/install-hooks.sh`) blocks commits containing U+FFFD
encoding corruption. ESLint (`npm run lint`) catches unused vars, undefined
globals and shadowing; core modules carry JSDoc types for editor-time checking.

## Security notes

- `.gitignore` blocks `.env`, tokens, HMACs, `.pid/.lock`, `.log`, `health-state.json`, `adapter-seen.jsonl`, `failed-events.jsonl`, `control-plane.json` (real IDs), `control-plane.staged.json`.
- `health-state.json` contains only non-sensitive diagnostics.
- Rotate `DISCORD_TOKEN` and `ADAPTER_TOKEN` if they were ever committed elsewhere.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `FATAL: DISCORD_TOKEN is missing` | copy `.env.example` ? `.env`, set `DISCORD_TOKEN` |
| `LOGIN FAIL An invalid token was provided` | reset token in Discord developer portal |
| `Gateway already running pid -` (exit 3) | intended - use `--action=restart` |
| `lock state unknown` (exit 4) | fail-safe; inspect pid manually, then remove `.bot.lock` |
| Full mode not enabling (still minimal) | check `control-plane.json` exists and is valid JSON + `GUILD_ID` is set and is 17-20 digits |
| adapter `401 bad_signature` | recompute HMAC over `timestamp.nonce.body` with current `ADAPTER_TOKEN` |
| adapter `429` | wrong token being retried - fix `ADAPTER_TOKEN` |

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

Elastic-2.0.
