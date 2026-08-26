#!/usr/bin/env node
// index.js — foreground entrypoint (8 chars, under Pterodactyl MAIN_FILE caps).
// SIGTERM/SIGINT reach gateway.mjs directly for graceful shutdown + lock cleanup.
// Use: node index.js | Pterodactyl: node /home/container/index.js | config: .env
import './gateway.mjs';
