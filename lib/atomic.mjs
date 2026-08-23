// lib/atomic.mjs — durable JSON writes shared by every component.
// fs.rename overwrites the destination atomically on Windows (MoveFileEx);
// there is deliberately no pre-unlink of the destination (that gap is where
// a crash could lose the old file before the new one lands).
import { writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function atomicWriteJson(path, data) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, JSON.stringify(data, null, 2));
    try { fsyncSync(fd); } catch { /* best effort durability */ }
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* temp already gone */ }
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, path);
}
