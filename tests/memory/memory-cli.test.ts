import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import * as workerUtils from '../../src/shared/worker-utils.js';
import { cwdToDashed } from '../../src/services/context/ObservationCompiler.js';
import { runMemoryCommand } from '../../src/services/memory/cli.js';
import { memoryDirForCwd, type MemoryIngestReport } from '../../src/services/memory/ingest.js';

describe('memory ingest CLI', () => {
  const spies: Array<{ mockRestore(): void }> = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  function captureErrors(): string[] {
    const errors: string[] = [];
    spies.push(spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    }));
    return errors;
  }

  // R5-5: the npx CLI runs this from the plugin root, so the caller's checkout
  // arrives as --cwd. A checkout with no memory dir names the dir it looked in.
  const callerCheckout = join(tmpdir(), 'claude-mem-r55-checkout-without-memory');

  it("defaults to the memory dir of the caller's --cwd, not the process cwd (R5-5)", async () => {
    const errors = captureErrors();

    expect(await runMemoryCommand('ingest', ['--dry-run', '--cwd', callerCheckout])).toBe(1);

    expect(errors).toEqual([`memory ingest source not found: ${memoryDirForCwd(callerCheckout)}`]);
  });

  it("resolves a relative --source against the caller's --cwd (R5-5)", async () => {
    const errors = captureErrors();

    expect(await runMemoryCommand('ingest', ['--dry-run', '--cwd', callerCheckout, '--source', 'notes'])).toBe(1);

    expect(errors).toEqual([`memory ingest source not found: ${join(callerCheckout, 'notes')}`]);
  });

  it('resolves a relative --cwd before deriving its memory dir', async () => {
    const errors = captureErrors();

    expect(await runMemoryCommand('ingest', ['--dry-run', '--cwd', 'claude-mem-r55-relative-checkout'])).toBe(1);

    expect(errors).toEqual([
      `memory ingest source not found: ${memoryDirForCwd(resolve('claude-mem-r55-relative-checkout'))}`,
    ]);
  });

  // The projects directory is fixed when the module loads, so a populated
  // checkout is dry-run in a child process pointed at a scratch config dir,
  // started somewhere else: the notes can only be found through --cwd.
  it("dry-runs the notes in the caller's checkout (R5-5)", () => {
    const configDir = mkdtempSync(join(tmpdir(), 'claude-mem-r55-config-'));
    try {
      const checkout = join(configDir, 'code', 'app');
      const memoryDir = join(configDir, 'projects', cwdToDashed(checkout), 'memory');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, 'decisions.md'), '# Decisions\n\nTests run under bun.\n');
      const cliModule = join(import.meta.dir, '../../src/services/memory/cli.ts');
      const script =
        `import(${JSON.stringify(cliModule)}).then(async ({ runMemoryCommand }) => {` +
        ` process.exitCode = await runMemoryCommand('ingest', ['--dry-run', '--cwd', ${JSON.stringify(checkout)}]); });`;

      const child = Bun.spawnSync({
        cmd: [process.execPath, '-e', script],
        cwd: configDir,
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, DO_NOT_TRACK: '1', CLAUDE_MEM_TELEMETRY: '0' },
      });

      expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toMatchObject({ exitCode: 0 });
      expect(child.stdout.toString()).toContain('TOTAL: 1 memory dirs → 1 files');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('names every skipped note and its reason', async () => {
    const report: MemoryIngestReport = {
      source: '/projects/-home-u-repo/memory',
      all: false,
      dirs: 1,
      found: 3,
      stored: 1,
      deduped: 1,
      skipped: 1,
      failed: 0,
      cwdUnresolvedDirs: 0,
      files: [
        { project: 'repo', file: 'kept.md', status: 'stored', observationId: 7 },
        { project: 'repo', file: 'seen.md', status: 'deduped' },
        { project: 'repo', file: 'notes.md', status: 'skipped', reason: 'symlink (not followed)' },
      ],
    };
    const lines: string[] = [];
    spies.push(
      spyOn(workerUtils, 'ensureWorkerRunning').mockResolvedValue(true),
      spyOn(workerUtils, 'workerHttpRequest').mockResolvedValue(new Response(JSON.stringify(report))),
      spyOn(console, 'log').mockImplementation((line: unknown) => {
        lines.push(String(line));
      }),
    );

    expect(await runMemoryCommand('ingest', ['--source', report.source])).toBe(0);

    expect(lines).toContain('repo/notes.md: skipped (symlink (not followed))');
    expect(lines).toContain('repo/kept.md: stored -> obs #7');
    expect(lines.some(line => line.includes('seen.md'))).toBe(false);
  });
});
