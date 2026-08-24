# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.0.0] — 2026-08-24

**Breaking release** — scope change to a single-purpose runtime. The logging
channels, autorole and control-plane systems were removed entirely; the
runtime is now an always-online Discord gateway presence with health telemetry
and a hardened local adapter. **`.env` needs only `DISCORD_TOKEN`** — no
guild/channel/role/user IDs anywhere.

### Removed
- **Logging system**: event pipeline (`event-pipeline.mjs`) with its five
  queues, all six log-channel targets (JOIN_LEAVE / VOICE_LOG / MOD_LOG /
  MESSAGE / MEMBER / SERVER), and every gateway listener that fed them.
- **Autorole system**: role auto-assignment, `memberRoleName`.
- **Control plane** (`control-plane.json` + `config-manager.mjs` +
  `lib/config.mjs`): schema, staged/diff/apply/rollback lifecycle,
  `ownerId`, `controlPlaneAllowedRoles`, `requireAuditForModLog`.
- **Adapter config actions**: `suggestConfig`, `applyConfig`,
  `listChannels` (and their schemas/key-blocklists). Allowlist is now
  `getStatus, diagnose, readLogs`.
- **Dependency**: `zod` (only used by the removed control-plane schema).
  Remaining deps: `discord.js`, `dotenv`.
- Gateway now declares **zero intents** and zero listeners (nothing
  privileged, minimal bandwidth); the message-cache sweeper knob went with it.
- Tests for removed systems: `test-pipeline.mjs`, `test-config.mjs`,
  `test-adapter-validation.mjs`; pipeline cases in
  `test-stability-fixes.mjs`.

### Changed
- `autorole-logger.mjs` → **`gateway.mjs`** (name matches what it now is).
  Supervisor mode `gateway` added; legacy `--mode=logger` still works and
  pre-v2 `.bot.lock` files still verify against their original script
  (fail-safe upgrade path).
- **getStatus rewritten**: reads local atomic files only (`bot-state.json`,
  `health-state.json`, `.bot.lock`) — no subprocess spawn per request, no
  stale Discord data; websocket state + snapshot age included.
- **Rate limit moved after authentication**: failed auths consume their own
  brute-force bucket; unauthenticated local processes can no longer exhaust
  the authenticated request budget.
- Temp log dir `%TEMP%\opencode\` → `%TEMP%\al-ai-bot-runtime\`
  (`logger-out.log` → `gateway-out.log`); Linux/Pterodactyl compatible.
- Partial member/author guards became moot: there are no event listeners left
  to receive partial entities.
- `health-state.json` no longer references control-plane/config-lifecycle.

### Fixed
- **Linux/Pterodactyl stale-lock handling**: `gateway.mjs` imported
  `verifyProcess` directly from the Windows-only layer
  (`process-verification.mjs`, PowerShell/CIM) — on Linux a crashed run's
  `.bot.lock` could never be verified dead and the gateway refused to start
  (exit 4). It now goes through the cross-platform dispatcher in
  `lib/platform.mjs` (`/proc` + signal probes on POSIX).
- **Clean exit on login failure**: a bad `DISCORD_TOKEN` raced the closing
  websocket handle inside a bare `process.exit()` and crashed with a libuv
  assertion on Windows (exit code -1073740791). The client is now destroyed
  and libuv given 200 ms to settle before exiting with code 1.

## [1.0.3] — 2026-08-24

P0 correctness fixes from the second full audit. No wire-format, lock-protocol
or schema changes; out-of-the-box timings are byte-for-byte identical to 1.0.2.

### Fixed
- **Wrongful config rollback on health check** (`config-manager.mjs`): the
  gateway liveness probe used a raw `process.kill(pid, 0)` whose catch-all
  treated `EPERM` as "not alive" — but per Node's documented signal-0 contract,
  EPERM means the process EXISTS (restricted/other-owner). A healthy gateway
  could therefore fail the post-apply health check and trigger a rollback.
  Now uses the shared `verifyProcess` platform layer (EPERM-aware, with
  cmdline/PID-reuse matching); `unknown` counts as unhealthy and follows the
  existing rollback path.
- **Moderation queue had no real cap**: above `max*1.5` the pipeline only
  logged a warning while continuing to enqueue, so sustained floods grew
  memory without bound. There is now an actual hard cap: at `max*1.5` the
  event is persisted to `failed-events.jsonl` (already written before the cap
  check) and NOT queued — memory stays bounded, nothing is lost. Regression:
  `test-stability-fixes.mjs` T13.
- **Graceful shutdown dropped queued events**: SIGTERM/SIGINT destroyed the
  client and exited without draining queues or the pending moderation batch,
  violating "moderation is never dropped" during shutdown. New
  `EventPipeline.persistAllPending(reason)` drains every queue plus
  `pendingMod` into `failed-events.jsonl` (sanitized primitives) BEFORE the
  client is destroyed. Regression: T14.
- **Broken join/leave channel no longer punished the moderation path**
  (`event-pipeline.mjs`): the plain-leave embed (non-kick outcome of
  `leaveOrKick`) is informational and targets JOIN_LEAVE, yet its failures
  were recorded on the MOD_LOG circuit and burned moderation retries on audit
  re-lookups. Failures now land on the JOIN_LEAVE circuit itself and the
  embed is dropped under pressure (same policy as voice/message).
  Regression: T15.

### Changed
- **control-plane timing knobs are now actually wired** (`event-pipeline.mjs`):
  `debounceMs` was bypassed by hardcoded literals at all four call sites
  (member/roleUpdate/voice 2500, message 5000) and `suppressMs` had no
  consumer at all. Member/roleUpdate/voice debounce now use `debounceMs`,
  message dedupe uses `debounceMs * 2`, and ban/mute suppression uses
  `max(suppressMs, AUDIT_WINDOW_MS)`. With the shipped defaults the effective
  values are identical to 1.0.2 (2500 / 2500 / 2500 / 5000 / 12000ms) — only
  custom-configured values change behaviour, as they always should have.
- New exported constant `AUDIT_WINDOW_MS` (12000ms): single source shared by
  the audit-log freshness check in `autorole-logger.mjs` and the suppression
  floor in `event-pipeline.mjs`.
- **health-state reflects the real websocket** (`health-state.mjs`):
  `gateway.state` was `'connected'` whenever `.bot.lock` existed — even while
  discord.js was reconnecting. The gateway now feeds `client.ws.status` into
  the snapshot: `connected` only when the websocket is truly Ready, otherwise
  `connecting / reconnecting / idle / nearly / disconnected`; `lock-only`,
  `starting`, `stopped` are kept for snapshots without websocket info.
  Regression: T16.
- **Perf**: supervisor `waitForReady` reads only the last 8 KB of the gateway
  log per 500 ms poll instead of the whole (up to 10 MB) file each tick.
- Dead import removed (`renameSync` in `autorole-logger.mjs`).

## [1.0.2] — 2026-08-23

Cross-platform support on top of v1.0.1. Single Gateway Runtime, atomic lock,
pipeline behaviour and the control-plane contract are unchanged.

### Added
- **`lib/platform.mjs`** — one process API for the supervisor with two
  implementations: POSIX (`/proc/<pid>/cmdline`, signal-0 probes, `SIGKILL`,
  direct detached spawn — no PowerShell/WMI/taskkill anywhere) and the existing
  proven Windows behaviour (WMI spawn wrapper, CIM/tasklist verification,
  `taskkill /T /F`). `bot-supervisor.mjs` now contains **zero platform
  branches**; `process-verification.mjs` is explicitly the Windows layer.
- **`index.js` entrypoint** (8 chars — under Pterodactyl-style 16-char
  `MAIN_FILE` caps): plain JavaScript ESM, no TypeScript/ts-node/build step.
  Runs the gateway in the foreground so container/panel signals (SIGTERM from
  `docker stop`/panel stop, SIGINT from Ctrl+C) reach it directly; graceful
  shutdown and lock cleanup unchanged. `npm start` added.
- **`Dockerfile` + `.dockerignore`** — node:20-slim, `npm ci --omit=dev`,
  exec-form CMD (node is PID 1, SIGTERM-safe). Secrets and local config are
  never baked into the image.
- **Optional resource knobs** (clamped, never required, defaults preserved):
  `HEALTH_INTERVAL_MS` (5000–300000, default 20000), `LOG_MAX_BYTES`
  (1MB–100MB, default 10MB), `LOG_RETENTION_FILES` (1–100, default 14),
  `MESSAGE_CACHE_SWEEP_SECONDS` (300–86400, default 1800) via the new
  `readEnvInt` in `lib/env.mjs`.
- **`test-platform.mjs`** — exercises the real platform lifecycle (detached
  spawn → verify with command match → force-kill → verify dead) plus
  PID-reuse-guard, test-hook and entrypoint contracts on whichever OS runs
  the suite. The test runner now also asserts `node index.js` fails fast with
  a clear message (before any Discord traffic) when config is missing.
- README **Deployment** section: Windows, Linux/VPS, Docker, Pterodactyl
  (recommended startup command `node /home/container/index.js`), resource
  profile (256 MB recommended / 128 MB minimum).

### Changed
- `gracefulStop` last-resort kill now uses `taskkill /T /F` (tree) on Windows
  via the platform layer — previously the child node process of the cmd
  wrapper could survive a `/F`-only kill.

### Tested
- Windows: full suite (`npm ci`, `npm run check`, `npm test`) including the
  live spawn/kill lifecycle through the Windows layer. POSIX implementation is
  contract-tested (signal-probe fallback verified) but was **not** executed on
  a real Linux host in this environment (WSL service unavailable, no Docker) —
  see README for what each platform claim rests on.

## [1.0.1] — 2026-08-23

Final quality audit on top of v1.0.0. Every change is backed by a proven defect
or an official-documentation finding; no cosmetic rewrites.

### Fixed
- **Moderation events were silently lost instead of persisted**: events carrying
  raw Discord structures (`GuildMember` on leave/kick, audit-actor `User`) hit
  circular client references in `JSON.stringify`, so `failed-events.jsonl`
  writes failed silently — violating the "moderation is never dropped"
  guarantee. `sanitizeForFailed` now keeps primitives only (plus `actorId` /
`authorId` identifiers) and persistence always succeeds. Regression-tested by
  `test-stability-fixes.mjs` T12, which failed before the fix and passes after.

### Changed
- Removed the **GuildPresences** privileged intent: the runtime has no
  `presenceUpdate` listener, and per the discord.js guide that intent only
  adds gateway bandwidth (one fewer privileged toggle in the Developer Portal).
  `GuildModeration` stays — `guildBanAdd`/`guildBanRemove` require it.
- Added a **message-cache sweeper** (sweep every 5 minutes, lifetime 30 minutes;
  units in seconds per the official guide's Cache Customization page) so memory
  stays flat on busy guilds — edit/delete logging only needs recent messages.

### Removed
- Dead code proven unused by search: `checkPid`/`isAliveSafe` in
  `bot-supervisor.mjs` (no call sites), the unused `setLastError` import in
  `autorole-logger.mjs`, and a no-op `safeReadJson(... ? null : null)`
  expression in `health-state.mjs`. The supervisor now uses the shared
  `lib/atomic.mjs` write instead of its last local copy.

## [1.0.0] — 2026-08-23

First stable release. Focus: make the runtime genuinely config-driven, unify the
codebase around shared modules, and make every documented guarantee real.

### Changed
- **`control-plane.json` is now the actual runtime config source.** The gateway
  reads the six log channels, pipeline timings and autorole settings from it via
  `lib/config.mjs`; guild identity comes from `OMNICORD_GUILD` in `.env`. All
  hardcoded guild/channel IDs were removed from `autorole-logger.mjs` and
  `event-pipeline.mjs`. Previously the config lifecycle validated a file nothing
  read at runtime.
- Environment access unified through `lib/env.mjs` **using `dotenv`** (it was a
  declared dependency but never used). Missing keys now produce one actionable
  error listing everything missing, instead of a `TypeError` on a null regex
  match; values with quotes/comments parse correctly.
- The Zod schema lives once in `lib/config.mjs` and is shared by
  `config-manager` and the gateway, so what is validated is exactly what runs.
- Atomic JSON writes unified in `lib/atomic.mjs` (previously four slightly
  different copies, one with an unsafe pre-unlink).
- All temp/log paths derive from `os.tmpdir()` via `lib/paths.mjs`; the
  hardcoded `C:\Users\<name>\AppData\Local\Temp` fallbacks are gone, and the
  gateway log directory is auto-created so a fresh machine can never fail the
  spawn redirect.
- `bot-supervisor` spawn path: `spawnRuntime` is async with real sleeps
  (previously six `powershell Start-Sleep` processes per startup).
- `integration-adapter`: handlers moved to a `HANDLERS` registry (adding an
  action no longer touches the request pipeline), staged config writes use the
  shared atomic helper, and `SIGINT` shuts down cleanly like `SIGTERM`.
- `control-plane.example.json`: `ownerId` placeholder is now snowflake-shaped
  and an `autorole` section is documented — **the shipped example now passes its
  own validation**.
- README rewritten to match the implementation: correct test order (adapter
  suites need a running adapter — `npm test` manages it), the lock-based
  single-gateway guarantee described as implemented (the previous "launch-token
  handoff" claim existed only in docs), a configuration table, and a
  troubleshooting section.

### Fixed
- Moderation **batch flush retries**: `flushMod` previously persisted failures
  on the first error with no retry; it now retries at most twice with backoff
  (matching the queue-level policy) before writing to `failed-events.jsonl`.
  Events without a `guildId` are persisted instead of sent to a guessed guild.
- `test-adapter-hardened.mjs` crashed on the oversized-body test (the server
  destroys the socket; the client `fetch` threw unhandled), so tests 6–10 never
  ran. The test now treats 413 *or* a destroyed socket as pass, and the
  rate-limit burst test runs last because it saturates the per-IP limiter.
- `test-stability-fixes.mjs` T8/T9 instrumented the wrong layer (they expected
  queue-level retries for events that actually go through the batch flush);
  rewritten to assert the real paths: exact retry counts, exhaustion persisted,
  FIFO order preserved.
- Dead code removed: unused `AuditLogEvent` import, the never-defined
  `pipeline.normalize` branch in `GuildMemberAdd`, stale supervisor constants,
  and the orphan `launch-handoff.json` gitignore entry.

### Added
- `lib/` shared modules: `env.mjs` (dotenv + strict validation), `config.mjs`
  (schema, `loadControlPlane`, `resolveRuntimeConfig`), `atomic.mjs`, `paths.mjs`.
- `tools/check.mjs` — dependency-free static checks (syntax, JSON/schema,
  `.env.example` key coverage); `tools/run-tests.mjs` — `npm test` runner that
  auto-creates `.env` (generated `ADAPTER_TOKEN`, placeholder Discord values)
  and starts/stops the adapter around the HTTP suites.
- `test-config.mjs` — config/env contract tests (example validates, friendly
  errors, runtime resolution, autorole defaults).
- Optional `autorole` config section (`enabled`, `memberRoleName`) with
  backwards-compatible defaults; `npm` scripts for stop/check/test/config.

### Compatibility
CLI flags, adapter wire format, lock semantics, and file names are unchanged.
The one behavioral migration: the gateway now **requires** a valid
`control-plane.json` (copy the example) instead of silently using baked-in IDs.
