# Engineering Guardrails

These rules are mandatory for humans and AI coding agents working on this repository.

## 1. Preserve the runtime contract

- Do not remove or weaken an existing feature merely to simplify code.
- Do not change Discord intents, queue limits, retry behaviour, lock semantics, audit resolution, persistence, MCP authentication, rate limiting, or config validation without a regression test and an explicit architecture note.
- Prefer refactoring behind the same public behaviour over changing behaviour.
- Keep `index.js` as the foreground entrypoint and keep its short filename for hosting compatibility.

## 2. Single-responsibility boundaries

- `gateway.mjs` owns Discord event intake and runtime lifecycle.
- `event-pipeline.mjs` owns bounded queues, scheduling, retries and persistence.
- `integration-adapter.mjs` is only a local control boundary; it must not contain duplicated Discord business logic.
- `lib/discord.mjs` is the single Discord REST/service boundary.
- `lib/config.mjs` and `config-manager.mjs` own configuration schema, validation and atomic apply/rollback.
- `lib/platform.mjs` owns Windows/POSIX process differences.
- `health-state.mjs` owns the health snapshot; diagnostics must not make live Discord calls just to report health.

## 3. Security invariants

- Never commit `.env`, bot tokens, adapter tokens, cookies, private keys, or raw secrets.
- Never log authentication headers, tokens, signatures, full request bodies, or sensitive configuration.
- MCP remains loopback-only by default, HMAC authenticated, replay-protected, rate-limited and allowlisted.
- Never add shell execution, arbitrary OS command execution, dynamic module loading from user input, or an unbounded file/network primitive to the adapter.
- Validate every external input at the boundary with the existing schemas or a stricter schema.
- Preserve fail-closed behaviour for unknown or corrupt process locks.

## 4. Performance and memory

- Keep queues bounded. Never introduce an unbounded in-memory event list.
- Prefer streaming/tail reads over loading large log files into memory.
- Do not add a framework or dependency when Node.js built-ins can solve the problem safely.
- Avoid duplicate caches, duplicate Discord clients, polling loops that duplicate existing health state, and per-event allocations that can be avoided.
- Any performance change must be measured before and after when practical.

## 5. Refactoring protocol

1. Read the existing implementation and tests before editing.
2. Identify the behaviour being protected.
3. Make the smallest safe change.
4. Run `npm run check` and `npm test`.
5. Run `npm run lint`.
6. For runtime changes, verify health, lock behaviour, shutdown, adapter authentication and pipeline persistence.
7. Never delete code solely because it looks duplicated; prove that all call paths are covered first.

## 6. Dependency policy

- Keep the runtime dependency surface small.
- Runtime dependencies must be justified by a real feature.
- Use the committed `package-lock.json`; production/deployment installs should use `npm ci`.
- Do not upgrade multiple major dependencies in the same functional change.

## 7. UI/control surface

This runtime currently has no separate web dashboard. The supported control surface is the local MCP adapter plus diagnostics endpoints. Do not invent a frontend dependency or UI framework unless a real product requirement is approved. Keep exposed controls task-oriented and minimal.

## 8. Release gate

A release is not complete until:

- all tests pass;
- static checks pass;
- lint passes;
- no secrets or local state are tracked;
- README and changelog match the shipped behaviour;
- the one-command bootstrap works on Windows and POSIX;
- the release notes explicitly state any intentional compatibility change.
