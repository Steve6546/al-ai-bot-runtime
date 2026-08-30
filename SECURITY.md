# Security and Data Handling

## Never commit

- `DISCORD_TOKEN`
- `ADAPTER_TOKEN`
- private keys, cookies, credentials, or personal access tokens
- `control-plane.json` when it contains private infrastructure identifiers that should not be public
- runtime state such as `.bot.lock`, `.bot.pid`, `bot-state.json`, `health-state.json`
- logs, failed-event queues, local dumps, or diagnostic exports unless they have been sanitized

The repository should contain templates and examples only.

## Logging rules

Logs are for operational and security diagnostics, not secret storage. Authentication values, tokens, signatures, passwords, source code, private keys and sensitive personal data must never be written to logs. Sanitize data before logging it. This follows OWASP guidance for excluding secrets and sensitive data from application logs.

## MCP/control adapter

The adapter is a local control boundary. Keep it bound to `127.0.0.1` by default. Requests must pass authentication, timestamp/nonce replay protection, allowlist checks, schema validation and rate limiting before a state-changing action is accepted.

Never expose the adapter directly to the public internet. If remote administration is required, put an authenticated, encrypted management layer in front of it rather than weakening the adapter's local trust boundary.

## Secrets rotation

If a Discord token or adapter secret is ever exposed:

1. rotate/revoke it immediately at the provider;
2. remove it from local logs and shared artifacts;
3. check Git history for accidental commits;
4. issue a new secret;
5. restart the runtime and verify the health snapshot.

## Dependency hygiene

Use the committed lockfile and `npm ci` for reproducible installs. Review dependency changes before merging and avoid unnecessary packages.

## Reporting

Do not publish tokens or private logs in GitHub issues. For a suspected vulnerability, preserve the smallest reproducible technical description and redact credentials before sharing it.
