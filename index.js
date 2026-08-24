#!/usr/bin/env node
// index.js — container/panel-friendly entrypoint (name is 8 characters, well
// under Pterodactyl-style MAIN_FILE caps). Plain JavaScript ESM: no
// TypeScript, no ts-node, no build step — run it with Node 20/22 directly.
//
// Runs the Single Gateway Runtime in the FOREGROUND so platform signals reach
// it directly: `docker stop` and panel stop buttons send SIGTERM, Ctrl+C sends
// SIGINT — both handled with graceful client shutdown + lock cleanup inside
// gateway.mjs. The single-gateway guarantee is unchanged wherever it runs
// from: the same atomic .bot.lock is acquired before touching Discord.
//
// Use:      node index.js        (or: npm start)
// Pterodactyl startup command:  node /home/container/index.js
// Config:    .env next to this file (DISCORD_TOKEN — see README).
import './gateway.mjs';
