#!/usr/bin/env node
/**
 * Unified foreground launcher.
 * Starts the single gateway and, when configured, the local MCP adapter.
 * Uses Node's process executable directly so Windows paths/spaces are safe.
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const node = process.execPath;
const children = new Map();
let shuttingDown = false;

function start(name, script) {
  const child = spawn(node, [join(root, script)], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: false,
    env: { ...process.env },
  });

  children.set(name, child);
  child.once('error', (error) => {
    console.error(`[launcher] ${name} failed to start: ${error.message}`);
  });
  child.once('exit', (code, signal) => {
    children.delete(name);
    if (!shuttingDown && name === 'gateway') {
      console.error(`[launcher] gateway stopped (code=${code ?? 'null'}, signal=${signal ?? 'none'}); stopping runtime.`);
      void shutdown(1);
    }
  });
  console.log(`[launcher] ${name} started (pid=${child.pid ?? 'unknown'})`);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const [name, child] of children) {
    if (child.exitCode === null && !child.killed) {
      console.log(`[launcher] stopping ${name}...`);
      try { child.kill('SIGTERM'); } catch (error) { console.error(`[launcher] ${name}: ${error.message}`); }
    }
  }
  setTimeout(() => process.exit(code), 1500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (error) => {
  console.error(`[launcher] uncaught exception: ${error.stack || error.message}`);
  shutdown(1);
});
process.on('unhandledRejection', (error) => {
  console.error(`[launcher] unhandled rejection: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  shutdown(1);
});

if (!existsSync(join(root, 'gateway.mjs'))) {
  console.error('[launcher] gateway.mjs is missing. Repository is incomplete.');
  process.exit(2);
}

start('gateway', 'gateway.mjs');

// The adapter is optional in minimal mode. Full control-plane mode requires it.
if (process.env.ADAPTER_TOKEN) {
  start('adapter', 'integration-adapter.mjs');
} else {
  console.log('[launcher] adapter skipped: ADAPTER_TOKEN is not configured (minimal mode).');
}
