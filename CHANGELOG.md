# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
