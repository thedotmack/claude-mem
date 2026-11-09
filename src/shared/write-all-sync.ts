// Write a whole string to a file descriptor before returning, even when the
// descriptor is a non-blocking pipe. Bun 1.3.9 turns a stdout/stderr pipe
// non-blocking once process.stdout is touched (logger.ts reads isTTY); from
// then on console.log and process.stdout.write keep only what fits in the
// pipe (64 KB) and a following process.exit drops the rest. A CLI whose
// output a parent captures (`library status --json`) writes through this
// instead.

import { writeSync } from 'fs';

/** Wait between retries while the pipe is full: the reader drains it as it reads; 1 ms keeps the wait from spinning a core. */
const FULL_PIPE_RETRY_MS = 1;

/**
 * Write all of `text` to `fd`. No retry cap: a cap would drop output, and a
 * reader that never reads is bounded by the reader's own timeout (e.g.
 * npx-cli/commands/library.ts LIBRARY_CHILD_TIMEOUT_MS kills this process).
 */
export function writeAllSync(fd: number, text: string): void {
  const bytes = Buffer.from(text, 'utf-8');
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FULL_PIPE_RETRY_MS);
    }
  }
}
