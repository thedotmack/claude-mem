#!/usr/bin/env node

const { closeSync, fstatSync, openSync, readSync, watchFile } = require('fs');
const path = require('path');
const os = require('os');

const LINE_COUNT = 50;
const POLL_INTERVAL_MS = 250;
const CHUNK_SIZE = 64 * 1024;

function todaysLogPath() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return path.join(os.homedir(), '.claude-mem', 'logs', `worker-${stamp}.log`);
}

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const bytes = readSync(fd, buffer, 0, length, position);
  if (bytes !== length) {
    throw new Error(`short read at ${position}: expected ${length} bytes, got ${bytes}`);
  }
  return buffer;
}

function countNewlines(buffer) {
  let count = 0;
  let index = buffer.indexOf(0x0a);
  while (index !== -1) {
    count++;
    index = buffer.indexOf(0x0a, index + 1);
  }
  return count;
}

// Worker logs grow without bound, so this walks backwards in fixed chunks until
// it has one more newline than it needs, rather than decoding the whole file to
// keep its last few lines. Reading one newline past the target also guarantees
// the chunk boundary is discarded with the partial line in front of it, so a
// multi-byte character split across chunks can never reach the output.
function readLastLines(fd, size, lineCount) {
  const chunks = [];
  let position = size;
  let newlines = 0;

  while (position > 0 && newlines <= lineCount) {
    const length = Math.min(CHUNK_SIZE, position);
    position -= length;
    const chunk = readAt(fd, position, length);
    chunks.unshift(chunk);
    newlines += countNewlines(chunk);
  }

  const lines = Buffer.concat(chunks).toString('utf-8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-lineCount);
}

const follow = process.argv.includes('--follow');
const logPath = todaysLogPath();

let fd;
try {
  fd = openSync(logPath, 'r');
} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', `Cannot read worker log ${logPath}: ${error.message}`);
  process.exit(1);
}

let size;
try {
  size = fstatSync(fd).size;
  const lines = readLastLines(fd, size, LINE_COUNT);
  if (lines.length > 0) console.log(lines.join('\n'));
} finally {
  closeSync(fd);
}

if (follow) {
  let offset = size;
  watchFile(logPath, { interval: POLL_INTERVAL_MS }, (current, previous) => {
    // A rename-and-recreate rotation can leave the replacement at exactly the
    // previous offset's size, so byte counts alone cannot detect it — a change
    // of file identity must also reset the read position. A missing file stats
    // as all-zero, and the size === offset check below skips the read until it
    // reappears.
    const replaced = current.ino !== previous.ino || current.dev !== previous.dev;
    if (replaced || current.size < offset) offset = 0;
    if (current.size === offset) return;
    const appended = openSync(logPath, 'r');
    try {
      const buffer = readAt(appended, offset, current.size - offset);
      offset += buffer.length;
      process.stdout.write(buffer);
    } finally {
      closeSync(appended);
    }
  });
}
