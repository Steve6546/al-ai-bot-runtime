# AL AI Bot Runtime (v2.0.0)

Production-hardened Discord **gateway presence runtime**. Single-instance, supervisor-enforced, always-online bot with health telemetry and a hardened local adapter. **Config is a single `DISCORD_TOKEN` in `.env`** — no server ID, no channel IDs, no role IDs, no user IDs. Cross-platform: Windows, Linux/VPS, Docker, Pterodactyl.

> v2 scope note: the Discord logging channels and the autorole system were removed. The runtime now provides exactly one thing done well: an always-online, single-gateway Discord presence with honest health reporting, graceful lifecycle management and a local control API.

This repository contains only the runtime layer (`gateway`, `bot-supervisor`, `integration-adapter`, shared `lib/`, `tools/` and tests). It does not bundle secrets or tokens.

## Architecture
```
.env (DISCORD_TOKEN, ADAPTER_TOKEN)
  → Single Gateway Runtime (bot-supervisor.mjs / index.js entrypoint)
      → gateway.mjs (discord.js v14, zero intents, no listeners)
      → health-state.json (real websocket status, memory, uptime)
      → .bot.lock (single-instance enforcement)
  → Discord Gateway

Model / Agent / MCP
  → integration-adapter (127.0.0.1:3415 only, HMAC-signed)
      → getStatus / diagnose / readLogs
```

## Prerequisites
- **Windows 10/11 or Linux** (macOS untested); containers via the included Dockerfile
- **Node.js 20 or 22 LTS** (≥20 required)
- A Discord bot application. **No privileged intents are required** — the runtime declares zero intents, so nothing needs to be toggled in the Developer Portal.
- Dependencies: `discord.js` + `dotenv` only

## Configuration — where things live

| Setting | File | Notes |
|---|---|---|
| `DISCORD_TOKEN` | `.env` | bot token; **the only required setting** |
| `ADAPTER_TOKEN` | `.env` | HMAC shared secret; required only when running the adapter |

Optional clamped knobs (`HEALTH_INTERVAL_MS`, `LOG_MAX_BYTES`, `LOG_RETENTION_FILES`) are documented in `.env.example` and never required.

## Quick start
```powershell
# 1) install deps
npm install

# 2) environment — the ONLY required value
copy .env.example .env
# edit .env -> DISCORD_TOKEN

# 3) foreground run (simplest)
node index.js

# or managed via the supervisor (enforces one Gateway):
node bot-supervisor.mjs --mode=gateway --action=start
node bot-supervisor.mjs --action=status
node bot-supervisor.mjs --action=stop
# gateway output: %TEMP%\al-ai-bot-runtime\gateway-out.log (dir auto-created)

# 4) adapter (separate process, optional) — also started manually:
node integration-adapter.mjs
# listening on 127.0.0.1:3415
```

## Deployment

**Platform support status (honest):** Windows — fully exercised by the local test suite (including live spawn/verify/kill). Linux/POSIX — implemented in `lib/platform.mjs` and contract-tested (signal-probe paths), but *not executed on a real Linux host* at release time. Docker — `Dockerfile` provided, not built in the release environment. macOS — untested, unsupported.

### Windows (local)
```powershell
npm ci
npm run start:gateway     # supervisor spawns the detached gateway
npm run status
npm run stop:gateway
```

### Linux / VPS (foreground or supervisor)
```bash
npm ci
node index.js             # foreground — recommended under systemd/pm2/Docker
node bot-supervisor.mjs --mode=gateway --action=start   # or detached
```
The gateway handles `SIGTERM`/`SIGINT` with graceful shutdown + lock cleanup, so `systemctl stop` works cleanly. Process verification on Linux uses `/proc` + signal probes — no PowerShell/WMI anywhere in the POSIX path.

### Docker
```bash
docker build -t al-ai-bot .
docker run -d --name al-bot \
  -e DISCORD_TOKEN=... \
  al-ai-bot
```
The image never bakes secrets (`.dockerignore`); pass env vars. `node index.js` is PID 1 in exec form, so `docker stop` (SIGTERM) triggers graceful shutdown within the default grace period.

### Pterodactyl / game panels
The panel is the process manager — do **not** use the supervisor inside the container. Recommended **Startup Command**:
```
node /home/container/index.js
```
`index.js` is 8 characters (under the 16-char `MAIN_FILE` cap), plain JavaScript ESM — no ts-node, no TypeScript, no build step. Upload the repo (without `node_modules`), run "npm ci" once via the panel console or reinstall, and set `DISCORD_TOKEN` as a panel variable. Stop/Restart buttons send signals the gateway handles gracefully. The same `.bot.lock` still prevents a second gateway on the same volume.

### Resource profile
Baseline RSS is Node + discord.js (~90–140 MB). With no event listeners and no caches the steady-state footprint stays flat. Logs rotate at 10 MB with 14 files kept. Recommended: **256 MB RAM / 0.5 vCPU**; minimum: 128 MB. CPU is essentially idle — there is no network polling and no message traffic processing.

## Single Gateway — how it is actually enforced
`.bot.lock` (atomic `wx` acquire, `pid/nonce/mode/processCommand/schemaVersion`) persists for the entire Gateway lifetime. A second gateway exits with code 2 while the lock holder is verified alive, and with code 4 when process verification is *unknown* — an unknown lock is never deleted and never bypassed (fail-safe). `.bot.pid` mirrors the pid for tooling. PID reuse is guarded by command-line verification (`lib/platform.mjs`: Windows → CIM/tasklist/Get-Process with double confirmation; Linux → `/proc/<pid>/cmdline` + signal probes). Pre-v2 locks (`autorole-logger.mjs`) are still verified against their original script so upgrades fail safe.

## Health reporting
`health-state.json` (written by the live gateway every `HEALTH_INTERVAL_MS`, default 20s) contains only non-sensitive diagnostics: real websocket state (`connected` **only** when `client.ws.status` is Ready, otherwise `connecting/reconnecting/idle/nearly/disconnected`), uptime, memory. The adapter's `getStatus` reads this file plus `bot-state.json`/`.bot.lock` directly — no subprocess spawning, no stale REST data; the snapshot age is reported alongside.

## Integration adapter (local only)
- `POST http://127.0.0.1:3415/adapter/request` — **mandatory** headers:
  `X-Adapter-Token`, `X-Timestamp`, `X-Nonce`, `X-Signature: HMAC-SHA256(timestamp.nonce.body, ADAPTER_TOKEN)`
- `allowlist`: `getStatus, diagnose, readLogs`
- `BLOCKED`: `execOS, runShell, changeToken, updateSecrets, startGateway, …`
- `maxBody 64KB` (socket destroyed mid-upload), `timeout 5s`
- **Rate limit after authentication**: failed authentications have their own brute-force bucket (60/min) and can never exhaust the authenticated request budget (60/min per IP); replay is blocked by persistent `requestId`/nonce dedupe (24h/10min windows)

## Tests
```powershell
npm test          # everything: static checks, platform lifecycle, adapter suites
                  # (auto-creates .env if missing and starts/stops the adapter)
npm run check     # syntax + JSON + .env.example coverage only
node test-platform.mjs            # offline — cross-platform process layer (spawn/verify/kill)
node test-stability-fixes.mjs     # offline — health websocket contract
node test-adapter-hardened.mjs    # needs adapter running (or npm test)
```

## Security notes
- `.gitignore` blocks `.env`, tokens, HMACs, `*.pid`, `*.lock`, `*.log`, `health-state.json`, `adapter-seen.jsonl`.
- `health-state.json` contains only non-sensitive diagnostics.
- Rotate `DISCORD_TOKEN` and `ADAPTER_TOKEN` if they were ever committed elsewhere.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `FATAL: DISCORD_TOKEN is missing or empty.` | copy `.env.example` → `.env`, set `DISCORD_TOKEN` |
| `LOGIN FAIL An invalid token was provided` | reset the bot token in the Discord developer portal |
| `Gateway already running pid …` (exit 3) | intended — use `--action=restart` |
| `lock state unknown` (exit 4) | fail-safe; inspect the pid manually, then remove `.bot.lock` |
| adapter `401 bad_signature` | recompute HMAC over `timestamp.nonce.body` with the current `ADAPTER_TOKEN` |
| adapter `429 rate_limited …failed authentications` | wrong token being retried — fix `ADAPTER_TOKEN` on the caller side |

## Changelog
See [CHANGELOG.md](CHANGELOG.md).

## License
Same as upstream Omnicord: Elastic-2.0. See `LICENSE` if present in the Omnicord distribution.
