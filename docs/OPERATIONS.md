# Operations

## One command

After Node.js 22+ is installed and `.env` contains a valid `DISCORD_TOKEN`:

```powershell
npm run bootstrap
```

The bootstrap command installs the exact lockfile, creates a local `.env` when missing, generates a local adapter secret, runs static checks, and starts the unified runtime. It uses direct Node process spawning rather than shell command composition, which keeps Windows paths with spaces safe.

## First run

1. Copy/clone the repository.
2. Install Node.js 22+ (Node.js 24 LTS is the preferred runtime).
3. Run `npm run bootstrap` once.
4. If `.env` was created, set `DISCORD_TOKEN` and run `npm run bootstrap` again.
5. For full logging/autorole, set `GUILD_ID` and create `control-plane.json` from `control-plane.example.json`.
6. Keep `ADAPTER_TOKEN` private. Bootstrap can generate it locally.

## Useful commands

```powershell
npm run start:all
npm run status
npm run check
npm test
npm run lint
npm run config:validate
npm run replay
```

## Full-mode checklist

- Bot is installed in the target guild.
- Required intents are enabled in the Discord developer portal.
- `GUILD_ID` is correct.
- Six log channel IDs in `control-plane.json` are correct.
- `autorole.memberRoleName` points to the intended role.
- Bot role is high enough to manage the autorole.
- `ADAPTER_TOKEN` exists only in local secret storage.

## Stop/restart

For the production supervisor path, use:

```powershell
npm run status
npm run restart:gateway
npm run stop:gateway
```

The supervisor is the preferred detached process manager. `npm run start:all` is the simplest foreground development/maintenance launcher.

## Memory rules

Do not add a second Discord client. Do not convert bounded queues into arrays without a cap. Do not read entire log files for health checks. Keep diagnostics file-backed and lightweight.

## Recovery

If the gateway stops unexpectedly:

1. run `npm run status`;
2. inspect `health-state.json` and the tail of `gateway-out.log`;
3. run `npm run check`;
4. run `npm test`;
5. only then restart.

Never delete `.bot.lock` manually when its process state is unknown; the existing runtime intentionally fails closed in that situation.
