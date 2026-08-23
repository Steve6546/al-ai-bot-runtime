// lib/paths.mjs — single source for all filesystem locations.
// No component may hardcode user directories; everything derives from the
// project directory or the OS temp dir.
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

export const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

// Gateway stdout/stderr capture directory (supervisor redirects here).
export function gatewayLogDir() {
  return join(tmpdir(), 'opencode');
}

// Returns the gateway log path, creating the directory on demand so that a
// fresh machine never fails a `cmd /c ... > log` redirect to a missing dir.
export function gatewayLogPath() {
  const dir = gatewayLogDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, 'logger-out.log');
}
