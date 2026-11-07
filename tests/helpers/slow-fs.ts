// Slow-filesystem harness: simulates an on-access antivirus scanner and
// measures how long the event loop is held while code under test runs.
// Microsoft Defender on macOS runs as an Endpoint Security client; ES can hold
// a file open (AUTH_OPEN) but only notifies on write and stat. One machine's
// fs_usage traces showed opens of a busy log taking up to 2.03 s.
//
// The code under test runs in a child Bun process, as in
// worktree-adoption-event-loop.test.ts: the fs patch must be in place before
// the first ESM import of 'fs' (Bun snapshots a builtin's named exports at
// that point), and each run gets its own module singletons.
//
// Every open-like call on a path under the data dir waits openDelayMs: sync
// calls hold the calling thread (as the scanner holds the syscall), async
// calls wait off the event loop (as a thread-pool thread would). Writes and
// stats are not delayed, by design: ES has no auth event for them.
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

export interface SlowFsRun {
  /** Longest gap between two probe ticks, in ms. */
  maxTickGapMs: number;
  /** Sum over all ticks of the gap beyond the tick interval, in ms. */
  totalLagMs: number;
  /** Delayed open-like calls per path. */
  opens: Record<string, number>;
  /**
   * Time the simulated scanner held the calling thread, in ms (sync opens
   * only). Deterministic, unlike wall-clock lag on a loaded machine.
   */
  blockedMs: number;
  /** Whatever the driver body returned (JSON-serialisable). */
  result: unknown;
  /** The data directory the child used; deleted when cleanup() is called. */
  dataDir: string;
  cleanup: () => void;
}

export interface SlowFsOptions {
  openDelayMs: number;
  /** Async function body run in the child after the patch. `dataDir` is in scope. */
  body: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

const TICK_MS = 10;

const PATCH = String.raw`
const fs = require('fs');
const OPEN_DELAY_MS = Number(process.env.SLOW_FS_OPEN_DELAY_MS);
const PREFIX = process.env.SLOW_FS_PREFIX;
const opens = {};
let blockedMs = 0;
const block = ms => { blockedMs += ms; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const slowPath = p => {
  if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return null;
  const s = p instanceof URL ? p.pathname : String(p);
  return s.startsWith(PREFIX) ? s : null;
};
for (const name of ['openSync', 'appendFileSync', 'writeFileSync', 'readFileSync']) {
  const orig = fs[name];
  fs[name] = function (p, ...rest) {
    const s = slowPath(p);
    if (s) { opens[s] = (opens[s] || 0) + 1; block(OPEN_DELAY_MS); }
    return orig.call(this, p, ...rest);
  };
}
for (const name of ['open', 'appendFile', 'writeFile', 'readFile']) {
  const orig = fs[name];
  fs[name] = function (p, ...rest) {
    const s = slowPath(p);
    if (!s) return orig.call(this, p, ...rest);
    opens[s] = (opens[s] || 0) + 1;
    setTimeout(() => orig.call(this, p, ...rest), OPEN_DELAY_MS);
  };
}
for (const name of ['open', 'appendFile', 'writeFile', 'readFile']) {
  const orig = fs.promises[name];
  fs.promises[name] = async function (p, ...rest) {
    const s = slowPath(p);
    if (s) { opens[s] = (opens[s] || 0) + 1; await new Promise(r => setTimeout(r, OPEN_DELAY_MS)); }
    return orig.call(this, p, ...rest);
  };
}
`;

export function runWithSlowFs(options: SlowFsOptions): SlowFsRun {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-slow-fs-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const driver = join(root, 'driver.ts');
  writeFileSync(driver, `${PATCH}
const dataDir = process.env.CLAUDE_MEM_DATA_DIR;
const TICK_MS = ${TICK_MS};
let last = performance.now();
let maxTickGapMs = 0;
let totalLagMs = 0;
const timer = setInterval(() => {
  const now = performance.now();
  const gap = now - last;
  maxTickGapMs = Math.max(maxTickGapMs, gap);
  totalLagMs += Math.max(0, gap - TICK_MS);
  last = now;
}, TICK_MS);
const result = await (async () => { ${options.body} })();
// Let a few more ticks fire so a block at the very end is recorded.
await new Promise(resolve => setTimeout(resolve, TICK_MS * 4));
clearInterval(timer);
console.log('PROBE:' + JSON.stringify({ maxTickGapMs, totalLagMs, opens, blockedMs, result }));
`);
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    const child = spawnSync(process.execPath, [driver], {
      cwd: root,
      env: {
        PATH: dirname(process.execPath),
        HOME: root,
        USERPROFILE: root,
        TMPDIR: root,
        TEMP: root,
        TMP: root,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        CLAUDE_MEM_DATA_DIR: dataDir,
        CLAUDE_MEM_TELEMETRY_ENABLED: 'false',
        CLAUDE_MEM_TRACE_ENABLED: 'false',
        SLOW_FS_OPEN_DELAY_MS: String(options.openDelayMs),
        SLOW_FS_PREFIX: dataDir,
        ...options.env,
      },
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 30_000,
    });
    if (child.error || child.status !== 0) {
      throw new Error(`slow-fs child failed (status ${child.status}): ${child.error?.message ?? ''}\n${child.stderr}`);
    }
    const line = child.stdout.split('\n').find(l => l.startsWith('PROBE:'));
    if (!line) throw new Error(`slow-fs child printed no PROBE line:\n${child.stdout}\n${child.stderr}`);
    return { ...JSON.parse(line.slice('PROBE:'.length)), dataDir, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
