import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

/**
 * plan-17 step 2: a worker outage never blocks the user. The fail-loud counter
 * only ever produces a message, and the user sees it once per session through
 * a synchronous hook's systemMessage.
 *
 * Every case runs in a fresh bun process with its own CLAUDE_MEM_DATA_DIR. An
 * in-process test would reuse the DATA_DIR that paths.ts resolved when an
 * earlier test file imported it, and would then read and delete the real
 * ~/.claude-mem failure state. Asserting the child's real exit code is also the
 * only way to prove nothing calls process.exit(2).
 */

const REPO_ROOT = join(import.meta.dir, '..', '..');
const WORKER_UTILS_URL = pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts')).href;
const sandboxDirs: string[] = [];

interface OutageScriptResult {
  exitCode: number | null;
  stderr: string;
  output: any;
}

/**
 * Run `body` in a fresh bun process with worker-utils imported as `w`. The body
 * stores what it wants to assert in `out`, which comes back parsed as JSON.
 */
function runOutageScript(body: string, threshold = 3): OutageScriptResult & { dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-worker-outage-'));
  sandboxDirs.push(dataDir);
  const source = `
    const w = await import(${JSON.stringify(WORKER_UTILS_URL)});
    const out = {};
    ${body}
    process.stdout.write('OUT=' + JSON.stringify(out));
  `;
  const child = Bun.spawnSync([process.execPath, '-e', source], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: dataDir,
      CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: String(threshold),
      // The threshold trip sends hook_failed telemetry; keep it off the network.
      CLAUDE_MEM_TELEMETRY: '0',
    },
  });
  const stdout = new TextDecoder().decode(child.stdout);
  const match = /OUT=(.*)$/s.exec(stdout);
  return {
    dataDir,
    exitCode: child.exitCode,
    stderr: new TextDecoder().decode(child.stderr),
    output: match ? JSON.parse(match[1]) : null,
  };
}

afterEach(() => {
  for (const dir of sandboxDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('worker outage never blocks the hook', () => {
  // Adapted from the fail-open tests in #3225 (remten341) and #3269.
  it('keeps counting past the threshold, exits 0, and writes one diagnostic per outage', () => {
    const result = runOutageScript(`
      out.counts = [];
      for (let i = 0; i < 5; i++) out.counts.push(await w.recordWorkerUnreachable());
    `);

    // Before plan-17 the call that reached the threshold ran emitBlockingError,
    // and the process exited 2 here, which blocked the user's prompt.
    expect(result.exitCode).toBe(0);
    expect(result.output.counts).toEqual([1, 2, 3, 4, 5]);
    expect(result.stderr.match(/claude-mem worker unreachable/g)?.length).toBe(1);
    expect(result.stderr).toContain('claude-mem worker unreachable for 3 consecutive hooks');
    expect(result.stderr).toContain('your prompts are not blocked');

    const state = JSON.parse(readFileSync(join(result.dataDir, 'state', 'hook-failures.json'), 'utf-8'));
    expect(state).toMatchObject({ consecutiveFailures: 5, thresholdTripped: true });
  });
});

describe('consumeWorkerOutageNotice', () => {
  it('stays silent until the fail-loud latch trips', () => {
    const result = runOutageScript(`
      await w.recordWorkerUnreachable();
      await w.recordWorkerUnreachable();
      out.notice = await w.consumeWorkerOutageNotice('session-a');
    `);

    expect(result.exitCode).toBe(0);
    expect(result.output.notice).toBeNull();
  });

  it('shows the notice once per session per outage', () => {
    const result = runOutageScript(`
      for (let i = 0; i < 3; i++) await w.recordWorkerUnreachable();
      out.first = await w.consumeWorkerOutageNotice('session-a');
      out.repeat = await w.consumeWorkerOutageNotice('session-a');
      out.otherSession = await w.consumeWorkerOutageNotice('session-b');
      out.otherSessionRepeat = await w.consumeWorkerOutageNotice('session-b');
      out.firstSessionAgain = await w.consumeWorkerOutageNotice('session-a');
      out.noSession = await w.consumeWorkerOutageNotice(undefined);
    `);

    expect(result.exitCode).toBe(0);
    expect(result.output.first).toContain('claude-mem worker unreachable for 3 consecutive hooks');
    expect(result.output.first).toContain('your prompts are not blocked');
    expect(result.output.first).toContain('npx claude-mem restart');
    expect(result.output.repeat).toBeNull();
    expect(result.output.otherSession).toContain('claude-mem worker unreachable');
    expect(result.output.otherSessionRepeat).toBeNull();
    // Two sessions taking turns must not re-show it to each other.
    expect(result.output.firstSessionAgain).toBeNull();
    expect(result.output.noSession).toBeNull();
  });

  it('notifies the same session again for the next outage after the worker recovers', () => {
    const result = runOutageScript(`
      for (let i = 0; i < 3; i++) await w.recordWorkerUnreachable();
      out.firstOutage = await w.consumeWorkerOutageNotice('session-a');
      await w.__resetWorkerFailureCounterForTesting();
      out.afterRecovery = await w.consumeWorkerOutageNotice('session-a');
      for (let i = 0; i < 3; i++) await w.recordWorkerUnreachable();
      out.secondOutage = await w.consumeWorkerOutageNotice('session-a');
    `);

    expect(result.exitCode).toBe(0);
    expect(result.output.firstOutage).toContain('claude-mem worker unreachable');
    expect(result.output.afterRecovery).toBeNull();
    expect(result.output.secondOutage).toContain('claude-mem worker unreachable');
  });
});
