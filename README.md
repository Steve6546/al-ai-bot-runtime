# AL AI Bot Runtime

Production-hardened Discord bot runtime built around **Omnicord** — but the actual Discord Gateway is run by an independent external runtime. Single-Gateway, supervisor-enforced, event-pipeline + hardened local adapter.

This repository contains **only** the runtime layer (`autorole-logger`, `event-pipeline`, `bot-supervisor`, `integration-adapter`, `config-manager`, helpers and tests). It does **not** bundle secrets, tokens, or local state. Omnicord itself stays as an upstream dependency and is *not* modified.

## Architecture
```
Owner / config
  → Control plane (control-plane.json, schemaVersion 1, Zod validation)
  → Single Gateway Runtime (bot-supervisor.mjs is the ONLY entrypoint)
      → autorole-logger.mjs (discord.js v14)
      → event-pipeline.mjs (5 queues: moderation > member > server > voice > message)
      → queues / rate limits / audit resolver / logging dispatcher
  → Discord Gateway + REST

Model ↔ Agent ↔ Omnicord MCP (unchanged)
  → integration-adapter (127.0.0.1:3415 only)
  → control plane
```
Model/Agent/MCP never talk to the Gateway directly and never execute OS commands.

## Prerequisites
- Windows 10/11
- Node.js ≥ 20
- A Discord bot application + guild invite with intents: `Guilds, GuildMembers, GuildMessages, GuildVoiceStates, GuildPresences, MessageContent, GuildModeration`
- The Omnicord repository cloned alongside (or at least its `dist/` build) if you want MCP features — the runtime itself only needs `discord.js` + `zod`

## Quick start
```powershell
# 1) install deps
npm install

# 2) environment
copy .env.example .env
# edit .env -> DISCORD_TOKEN, OMNICORD_GUILD, ADAPTER_TOKEN
# generate ADAPTER_TOKEN:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3) config (safe example)
copy control-plane.example.json control-plane.json
# edit control-plane.json -> set your real channel IDs and owner roles

# 4) start / restart only via supervisor (enforces one Gateway)
node bot-supervisor.mjs --mode=logger --action=start
node bot-supervisor.mjs --action=status
# logs:
# %TEMP%\opencode\logger-out.log
# supervisor.log / adapter.log

# 5) adapter (separate, no Gateway) — started automatically by supervisor or run manually:
node integration-adapter.mjs
# listening on 127.0.0.1:3415

# 6) config lifecycle (never auto-applied)
node config-manager.mjs validate
node config-manager.mjs apply --source=manual  # validates → diffs → resource-checks → health-checks → rollback on failure
```

## Supervisor is the only way
Direct `node autorole-logger.mjs` is refused by a short-lived launch-token handoff. Always use:

```powershell
node bot-supervisor.mjs --mode=logger --action=restart
node bot-supervisor.mjs --action=stop
```

`.bot.lock` persists for the entire Gateway lifetime (`pid/nonce/mode/processCommand/schemaVersion` atomic JSON, `ParentProcessId` verification). `unknown` verification never deletes a lock nor starts a second Gateway.

## Pipeline guarantees
- 5 independent queues, weighted round-robin: `moderation 4 > member 2 > server 2 > voice 1 > message 1`
- `moderation` never dropped — overflow/persistent-failure → `failed-events.jsonl`
- `voice/message` may be merged/dropped under pressure (counters `dropped`)
- Event-driven + 350 ms rate limiter between Discord sends — not fixed 600 ms polling
- Per-destination circuit breaker: `3 failures → open 15s` (isolated, not global)
- Metrics: `queueDepth, oldestAgeMs, sent, failed, retried, dropped, circuitState`

## Integration adapter (local only)
- `POST http://127.0.0.1:3415/adapter/request` — **mandatory** headers:
  `X-Adapter-Token`, `X-Timestamp`, `X-Nonce`, `X-Signature: HMAC-SHA256(timestamp.nonce.body, ADAPTER_TOKEN)`
- `allowlist` for actions: `getStatus, suggestConfig, applyConfig, diagnose, readLogs, listChannels`
- `BLOCKED`: `execOS`, `changeToken`, `startGateway`, etc.
- `maxBody 64KB`, `timeout 5s`, `rateLimit 60/min`, persistent `requestId/nonce` dedupe
- `applyConfig` — strict allowlist on top-level (`schemaVersion, logging, permissions`) + deep blocked exact keys (`__proto__`, `constructor`, `prototype`, token/owner/path/port etc.); Zod strips unknowns on apply. Same `requestId` with different payload is rejected. No `tokenEnv/ownerIDs/paths/ports` changes allowed.

## Config lifecycle
`staged → validated (Zod) → diffed → resourceValidated (Discord channel/role existence) → applied (atomic temp→fsync→rename, 5 backups retained) → healthChecked (gateway + channel fetch) → rolled back on failure`. Never auto-applied.

## Tests
```powershell
node test-pipeline.mjs
node test-adapter-hardened.mjs
node test-adapter-validation.mjs
node test-stability-fixes.mjs
```

## Security notes
- This repo's `.gitignore` blocks `.env`, tokens, HMACs, `*.pid`, `*.lock`, `*.log`, `health-state.json`, `failed-events.jsonl`, `adapter-seen.jsonl`, `backups/`, `control-plane.json` (use `control-plane.example.json`), staged/backups.
- Use `.env.example` as template. Rotate `DISCORD_TOKEN` and `ADAPTER_TOKEN` if they were ever committed elsewhere.
- `health-state.json` contains only non-sensitive diagnostics.

## License
Same as upstream Omnicord: Elastic-2.0. See `LICENSE` if present in the Omnicord distribution.
