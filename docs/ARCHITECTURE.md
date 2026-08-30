# Architecture

## Goal

One lightweight Node.js service with a single Discord gateway, bounded event processing, a local authenticated MCP/control adapter, and file-backed health/config state.

## Runtime layers

```text
AI Agent / local operator
          |
          v
127.0.0.1:3415  integration-adapter
          |
          +--> authentication / replay protection / rate limit
          +--> allowlist / schema validation
          |
          v
       lib/discord  <----> Discord REST/Gateway
          ^
          |
gateway.mjs ----> event-pipeline.mjs ----> six configured log channels
     |
     +--> health-state.json
     +--> .bot.lock
     +--> failed-events.jsonl
```

## Feature inventory that must remain intact

- single gateway / single-instance lock;
- minimal zero-intent presence mode;
- full six-channel audit logging;
- five bounded event queues with weighted scheduling;
- debounce/suppression and per-channel circuit breakers;
- moderation batching, retry/backoff and durable failed-event persistence;
- graceful shutdown persistence;
- autorole;
- validated control-plane configuration and hot reload;
- health snapshot and Prometheus metrics;
- local MCP adapter with HMAC authentication, timestamp/nonce replay protection, dedupe, rate limiting and action allowlist;
- configuration suggestion/staging/apply/rollback path;
- Windows/POSIX process verification and safe lock handling;
- Docker/Pterodactyl-compatible foreground entrypoint.

## Boundaries

Avoid splitting the runtime into many services. The existing single-process gateway is intentional: it reduces memory use, duplicate Discord connections and operational complexity. The adapter may be a second lightweight process only when configured.

## Refactoring rule

If two modules appear to contain the same logic, first prove whether they serve different lifecycle or trust boundaries. Extract shared code only when the resulting dependency direction is clearer and the tests cover both paths.

## Configuration states

### Minimal mode

Only `DISCORD_TOKEN` is required. The gateway uses zero intents and reports presence/health.

### Full mode

`DISCORD_TOKEN`, `GUILD_ID` and a valid `control-plane.json` enable the configured event pipeline and autorole features.

### Control mode

`ADAPTER_TOKEN` enables the local MCP/control adapter. It never grants arbitrary shell or OS execution.
