#!/usr/bin/env node

const { closeSync, openSync, readFileSync, readSync, watchFile } = require('fs');
const path = require('path');
const os = require('os');

const LINE_COUNT = 50;
const POLL_INTERVAL_MS = 250;

function todaysLogPath() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return path.join(os.homedir(), '.claude-mem', 'logs', `worker-${stamp}.log`);
}

function readAppended(logPath, from, to) {
  const buffer = Buffer.alloc(to - from);
  const fd = openSync(logPath, 'r');
  try {
    const bytes = readSync(fd, buffer, 0, buffer.length, from);
    return buffer.subarray(0, bytes);
  } finally {
    closeSync(fd);
  }
}

const follow = process.argv.includes('--follow');
const logPath = todaysLogPath();

let contents;
try {
  contents = readFileSync(logPath, 'utf-8');
} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', `Cannot read worker log ${logPath}: ${error.message}`);
  process.exit(1);
}

const lines = contents.split('\n');
if (lines[lines.length - 1] === '') lines.pop();
if (lines.length > 0) console.log(lines.slice(-LINE_COUNT).join('\n'));

if (follow) {
  let offset = Buffer.byteLength(contents);
  watchFile(logPath, { interval: POLL_INTERVAL_MS }, current => {
    if (current.size < offset) offset = 0;
    if (current.size === offset) return;
    const appended = readAppended(logPath, offset, current.size);
    offset += appended.length;
    process.stdout.write(appended);
  });
}
