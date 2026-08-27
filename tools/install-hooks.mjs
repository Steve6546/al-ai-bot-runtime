#!/usr/bin/env node
// tools/install-hooks.mjs — cross-platform hook installer (replaces the
// POSIX-only install-hooks.sh). Copies tools/pre-commit.sh into .git/hooks/
// so every clone gets the U+FFFD encoding guard after: node tools/install-hooks.mjs
import { copyFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'tools', 'pre-commit.sh');
const dest = join(root, '.git', 'hooks', 'pre-commit');

if (!existsSync(join(root, '.git'))) {
  console.error('install-hooks: not a git repository (.git missing)');
  process.exit(1);
}
copyFileSync(src, dest);
// On POSIX, make hook executable
if (platform() !== 'win32') {
  try { chmodSync(dest, 0o755); } catch {}
}
console.log('hooks installed: .git/hooks/pre-commit (blocks U+FFFD encoding corruption)');
