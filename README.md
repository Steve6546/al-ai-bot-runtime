# AL AI Bot Runtime (v1.0.0)

Production-hardened Discord bot runtime built around **Omnicord** — but the actual Discord Gateway is run by an independent external runtime. Single-Gateway, supervisor-enforced, event-pipeline + hardened local adapter. **Since v1.0.0 the runtime is fully config-driven: no guild or channel IDs live in the code.**

This repository contains **only** the runtime layer (`autorole-logger`, `event-pipeline`, `bot-supervisor`, `integration-adapter`, `config-manager`, shared `lib/`, `tools/` and tests). It does **not** bundle secrets, tokens, or local state. Omnicord itself stays as an upstream dependency and is *not* modified.

## Architecture
```
Owner / config
  → .env (secrets + guild identity)  +  control-plane.json (behavior, Zod-validated)
  → Single Gateway Runtime (bot-supervisor.mjs is the ONLY entrypoint)
      → autorole-logger.mjs (discord.js v14) — resolves config via lib/config.mjs
      → event-pipeline.mjs (5 queues: moderation > member > server > voice > message)
      → queues / rate limits / audit resolver / logging dispatcher
  → Discord Gateway + REST

Model ↔ Agent ↔ Omnicord MCP (unchanged)
  → integration-adapter (127.0.0.1:3415 only, HMAC-signed)
  → control plane
```
Model/Agent/MCP never talk to the Gateway directly and never execute OS commands.

## Prerequisites
- **Windows 10/11** (the supervisor uses PowerShell CIM/WMI and `taskkill`; it is not cross-platform)
- **Node.js ≥ 20**
- A Discord bot application + guild invite with intents: `Guilds, GuildMembers, GuildMessages, GuildVoiceStates, MessageContent, GuildModeration` — `GuildPresences` is **not** needed (no presence listener; it is privileged and only adds bandwidth)
- The Omnicord repository cloned alongside (at least its `dist/` build) only if you want the `omnicord` runtime — the default `logger` runtime needs nothing beyond `discord.js`/`zod`/`dotenv`

## Configuration — where things live

| Setting | File | Notes |
|---|---|---|
| `DISCORD_TOKEN` | `.env` | bot token; required by gateway + config lifecycle |
| `OMNICORD_GUILD` | `.env` | the guild the logger watches; must be 17–20 digits |
| `ADAPTER_TOKEN` | `.env` | HMAC shared secret for the local adapter |
| `logging.channels.*` (6 IDs) | `control-plane.json` | **read by the running gateway** since v1.0.0 |
| `logging.debounceMs / batchMs / suppressMs` | `control-plane.json` | pipeline timings (wired since v1.0.0) |
| `autorole.enabled / memberRoleName` | `control-plane.json` | optional, defaults `true` / `Member` |
| `permissions.ownerId` | `control-plane.json` | **must be a numeric snowflake** (17–20 digits) |

Both files are validated at startup with one actionable error message — no stack traces for a missing key.

## Quick start
```powershell
# 1) install deps
npm install

# 2) environment
copy .env.example .env
# edit .env -> DISCORD_TOKEN, OMNICORD_GUILD, ADAPTER_TOKEN
# generate ADAPTER_TOKEN:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3) config — the shipped example PASSES validation (placeholders are snowflake-shaped)
copy control-plane.example.json control-plane.json
# edit control-plane.json -> real channel IDs, ownerId, roles
node config-manager.mjs validate

# 4) start / stop / status ONLY via supervisor (enforces one Gateway)
node bot-supervisor.mjs --mode=logger --action=start
node bot-supervisor.mjs --action=status
node bot-supervisor.mjs --action=stop
# gateway output: %TEMP%\opencode\logger-out.log (dir auto-created)
# supervisor/adapter/config lifecycle logs live next to the sources

# 5) adapter (separate process, no Gateway) — also started manually like this:
node integration-adapter.mjs
# listening on 127.0.0.1:3415

# 6) config lifecycle (never auto-applied)
node config-manager.mjs stage     # validates control-plane.staged.json
node config-manager.mjs diff      # old vs staged
node config-manager.mjs apply --source=manual
# apply = validate → diff → resource-check (channels/roles exist) → atomic write
#         with 5 rotating backups → health-check → rollback on failure
```

## Single Gateway — how it is actually enforced
`.bot.lock` (atomic `wx` acquire, `pid/nonce/mode/processCommand/schemaVersion`) persists for the entire Gateway lifetime. A second logger exits with code 2 while the lock holder is verified alive, and with code 4 when process verification is *unknown* — an unknown lock is never deleted and never bypassed (fail-safe). `.bot.pid` mirrors the pid for tooling. PID reuse is guarded by command-line verification (`process-verification.mjs`: CIM → tasklist → Get-Process, double-confirmation before declaring a pid dead).

## Pipeline guarantees
- 5 independent queues, weighted round-robin: `moderation 4 > member 2 > server 2 > voice 1 > message 1`
- Timings come from `control-plane.json` (`debounceMs`, `batchMs`, `suppressMs`)
- `moderation` never dropped — overflow is persisted to `failed-events.jsonl`; `voice/message` may be merged/dropped under pressure (counter `dropped`)
- Event-driven + 350 ms rate limiter between Discord sends
- Per-destination circuit breaker: `3 failures → open 15s` (isolated, not global)
- **Bounded retries on both moderation paths** (since v1.0.0): queue-level and batched-flush (`flushMod`) retry at most twice with backoff, then persist to `failed-events.jsonl` — never drop, never retry forever. Persisted events are sanitized to primitives (no raw Discord objects, no avatar URLs) so serialization can never silently lose them (since v1.0.1)
- Metrics: `queueDepth, oldestAgeMs, sent, failed, retried, dropped, circuitState`
- **Bounded memory** (since v1.0.1): the message cache is swept every 5 minutes (entries older than 30 minutes removed) — edit/delete logging only needs recent messages, so memory stays flat on busy guilds

## Integration adapter (local only)
- `POST http://127.0.0.1:3415/adapter/request` — **mandatory** headers:
  `X-Adapter-Token`, `X-Timestamp`, `X-Nonce`, `X-Signature: HMAC-SHA256(timestamp.nonce.body, ADAPTER_TOKEN)`
- `allowlist`: `getStatus, suggestConfig, applyConfig, diagnose, readLogs, listChannels`
- `BLOCKED`: `execOS, runShell, changeToken, updateSecrets, startGateway, stopGatewayWithoutSupervisor, …`
- `maxBody 64KB` (socket destroyed mid-upload), `timeout 5s`, `rateLimit 60/min/IP`, persistent `requestId/nonce` dedupe (24h/10min windows)
- Handlers live in a registry (`HANDLERS` in `integration-adapter.mjs`) — adding an action is one entry there plus its schema, without touching the request pipeline
- `applyConfig` — strict allowlist on top-level (`schemaVersion, logging, permissions`) + deep blocked exact keys (`__proto__`, `constructor`, `prototype`, token/owner/path/port …); Zod strips unknowns on apply. Same `requestId` with a different payload is rejected.

## Tests
```powershell
npm test          # everything: static checks, config/env, pipeline, adapter suites
                  # (auto-creates .env if missing and starts/stops the adapter)
npm run check     # syntax + JSON schema + .env.example coverage only
node test-pipeline.mjs            # offline
node test-config.mjs              # offline — config/env contract
node test-stability-fixes.mjs     # needs adapter running (or npm test)
node test-adapter-validation.mjs  # needs adapter running
node test-adapter-hardened.mjs    # needs adapter running (rate-limit burst runs last)
```

## Security notes
- `.gitignore` blocks `.env`, tokens, HMACs, `*.pid`, `*.lock`, `*.log`, `health-state.json`, `failed-events.jsonl`, `adapter-seen.jsonl`, `backups/`, `control-plane.json` (use `control-plane.example.json`), staged/backups.
- `health-state.json` contains only non-sensitive diagnostics.
- Rotate `DISCORD_TOKEN` and `ADAPTER_TOKEN` if they were ever committed elsewhere.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `FATAL: Missing required environment variable(s): …` | copy `.env.example` → `.env`, fill listed keys |
| `control-plane.json not found …` | copy `control-plane.example.json` → `control-plane.json` |
| `schema validation failed: permissions.ownerId …` | ownerId must be a numeric snowflake, not text |
| `LOGIN FAIL An invalid token was provided` | reset the bot token in the Discord developer portal |
| `Gateway already running pid …` (exit 3) | intended — use `--action=restart` |
| `lock state unknown` (exit 4) | fail-safe; inspect the pid manually, then remove `.bot.lock` |
| adapter `401 bad_signature` | recompute HMAC over `timestamp.nonce.body` with the current `ADAPTER_TOKEN` |

## Changelog
See [CHANGELOG.md](CHANGELOG.md).

## License
Same as upstream Omnicord: Elastic-2.0. See `LICENSE` if present in the Omnicord distribution.
