import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Tests for the `tail -n 50 ~/.claude-mem/logs/worker-$(date +%F).log`
 * replacement. `tail`, `date +%F` and `~` are all bash-only, so this is what
 * makes `npm run worker:logs` work in native PowerShell.
 *
 * The heap-constrained case is the real gate. Worker logs grow without bound
 * and the first version of this script read, decoded and split the whole file
 * before keeping its last 50 lines, so a busy worker's log aborted the process
 * with no output at exactly the moment someone needed to read it. Running under
 * --max-old-space-size makes a regression to slurping fail loudly instead of
 * merely getting slow.
 */

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'worker-logs.cjs');

function logStamp(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

describe('worker-logs', () => {
  let home: string;
  let logPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'claude-mem-worker-logs-'));
    mkdirSync(join(home, '.claude-mem', 'logs'), { recursive: true });
    logPath = join(home, '.claude-mem', 'logs', `worker-${logStamp()}.log`);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // Deliberately `node`, not process.execPath: under `bun test` execPath is
  // bun, which ignores --max-old-space-size, so the heap-constrained case below
  // would silently prove nothing. `npm run worker:logs` shells out to node too.
  function run(nodeArgs: string[] = []) {
    return spawnSync('node', [...nodeArgs, SCRIPT], {
      encoding: 'utf-8',
      // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
  }

  function outputLines(stdout: string): string[] {
    const lines = stdout.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  it('prints the last 50 lines of a 60-line log', () => {
    writeFileSync(logPath, Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');

    const result = run();
    const lines = outputLines(result.stdout);

    expect(result.status).toBe(0);
    expect(lines.length).toBe(50);
    expect(lines[0]).toBe('line 11');
    expect(lines[49]).toBe('line 60');
  });

  it('prints the whole log when it has fewer than 50 lines', () => {
    writeFileSync(logPath, 'only\ntwo\n');

    const result = run();

    expect(result.status).toBe(0);
    expect(outputLines(result.stdout)).toEqual(['only', 'two']);
  });

  it('exits 1 with the path when there is no log for today', () => {
    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(logPath);
  });

  it('tails a log far larger than the heap it is given', () => {
    // ~64 MiB, written in blocks so building the fixture does not itself need
    // the memory this test is proving we do not use.
    const fd = openSync(logPath, 'w');
    let line = 0;
    let written = 0;
    try {
      while (written < 64 * 1024 * 1024) {
        let block = '';
        for (let i = 0; i < 20000; i++) {
          line++;
          block += `line ${line}${' '.repeat(40)}payload\n`;
        }
        const buffer = Buffer.from(block);
        writeSync(fd, buffer);
        written += buffer.length;
      }
    } finally {
      closeSync(fd);
    }

    const result = run(['--max-old-space-size=16']);
    const lines = outputLines(result.stdout);

    expect(result.status).toBe(0);
    expect(lines.length).toBe(50);
    expect(lines[49].startsWith(`line ${line} `)).toBe(true);
    expect(lines[0].startsWith(`line ${line - 49} `)).toBe(true);
  }, 60000);
});
