#!/usr/bin/env node

const { closeSync, fstatSync, openSync, readSync, watchFile, unwatchFile } = require('fs');
const path = require('path');
const { resolveDataDir } = require('./resolve-data-dir.cjs');

const LINE_COUNT = 50;
const POLL_INTERVAL_MS = 250;
const CHUNK_SIZE = 64 * 1024;

function todaysLogPath() {
  const stamp = new Date().toISOString().slice(0, 10);
  return path.join(resolveDataDir(), 'logs', `claude-mem-${stamp}.log`);
}

// A single log entry can exceed the heap. Find the byte boundary in reverse
// without retaining the lines, then copy that range to stdout in bounded chunks.
function findTailStart(fd, size, lineCount) {
  const buffer = Buffer.alloc(CHUNK_SIZE);
  let position = size;
  let remaining = lineCount;
  while (position > 0) {
    const length = Math.min(position, CHUNK_SIZE);
    position -= length;
    const bytes = readSync(fd, buffer, 0, length, position);
    for (let i = bytes - 1; i >= 0; i--) {
      if (buffer[i] !== 0x0a || position + i === size - 1) continue;
      if (--remaining === 0) return position + i + 1;
    }
  }
  return 0;
}

async function writeRange(fd, offset, end) {
  const buffer = Buffer.alloc(Math.min(CHUNK_SIZE, end - offset));
  while (offset < end) {
    const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
    if (!bytes) break;
    await new Promise((resolve, reject) => {
      process.stdout.write(buffer.subarray(0, bytes), error => error ? reject(error) : resolve());
    });
    offset += bytes;
  }
  return offset;
}

const logPath = todaysLogPath();

async function main() {
  const fd = openSync(logPath, 'r');
  let followedIdentity;
  let offset;
  try {
    followedIdentity = fstatSync(fd);
    const size = followedIdentity.size;
    offset = await writeRange(fd, findTailStart(fd, size, LINE_COUNT), size);
  } finally { closeSync(fd); }

  if (!process.argv.includes('--follow')) return;
  let reading = false;
  let pending = false;

  async function drain() {
    if (reading) return;
    reading = true;
    try {
      while (pending) {
        pending = false;
        let appended;
        try { appended = openSync(logPath, 'r'); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        try {
          // Stat the opened descriptor: rotation may happen after the poll.
          const current = fstatSync(appended);
          if (current.ino !== followedIdentity.ino || current.dev !== followedIdentity.dev || current.size < offset) offset = 0;
          followedIdentity = current;
          offset = await writeRange(appended, offset, current.size);
        } finally { closeSync(appended); }
      }
    } finally { reading = false; }
  }

  function scheduleDrain() {
    pending = true;
    drain().catch(error => {
      console.error(`Cannot follow worker log ${logPath}: ${error.message}`);
      process.exitCode = 1;
      unwatchFile(logPath);
    });
  }
  watchFile(logPath, { interval: POLL_INTERVAL_MS }, (current) => {
    if (current.size === offset && current.ino === followedIdentity.ino && current.dev === followedIdentity.dev) return;
    scheduleDrain();
  });
  // An append while the snapshot was flushing may already be in the watcher's
  // initial baseline. Re-open once after registration instead of waiting for
  // some future append to reveal those bytes.
  scheduleDrain();
}

main().catch(error => {
  console.error(`Cannot read worker log ${logPath}: ${error.message}`);
  process.exitCode = 1;
});
