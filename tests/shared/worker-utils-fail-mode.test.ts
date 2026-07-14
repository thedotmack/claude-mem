import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// CLAUDE_MEM_HOOK_FAIL_MODE routes the fail-loud escalation in
// recordWorkerUnreachable (src/shared/worker-utils.ts): 'block' (default)
// preserves the #2292 emitBlockingError exit-2 contract; 'warn' surfaces the
// same message through emitDiagnostic but never exits, so a dead worker
// cannot gate UserPromptSubmit delivery. These tests assert the routing at
// the hook-io seam (same rationale as hook-stream-discipline.test.ts: never
// spawn the built daemon from tests).

// DATA_DIR is resolved at import time from CLAUDE_MEM_DATA_DIR, so the env
// var must be set before worker-utils is (dynamically) imported below.
const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-fail-mode-'));
process.env.CLAUDE_MEM_DATA_DIR = dataDir;

// Mutable per-test settings served through the loadFromFileOnce seam.
let settingsUnderTest: Record<string, string> = {};

const blockingCalls: string[] = [];
const diagnosticCalls: string[] = [];

mock.module('../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => settingsUnderTest,
}));

mock.module('../../src/shared/hook-io.js', () => ({
  emitBlockingError: (msg: string) => { blockingCalls.push(msg); },
  emitDiagnostic: (msg: string) => { diagnosticCalls.push(msg); },
}));

// The threshold-trip telemetry POST is out of scope here; keep tests offline.
mock.module('../../src/services/telemetry/cli-telemetry.js', () => ({
  captureCliEvent: () => Promise.resolve(),
}));

const { recordWorkerUnreachable } = await import('../../src/shared/worker-utils.js');

function seedFailureState(consecutiveFailures: number): void {
  mkdirSync(join(dataDir, 'state'), { recursive: true });
  writeFileSync(
    join(dataDir, 'state', 'hook-failures.json'),
    JSON.stringify({ consecutiveFailures, lastFailureAt: consecutiveFailures > 0 ? 1 : 0 }),
  );
}

beforeEach(() => {
  blockingCalls.length = 0;
  diagnosticCalls.length = 0;
  seedFailureState(0);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('CLAUDE_MEM_HOOK_FAIL_MODE routing in recordWorkerUnreachable', () => {
  it('block mode (default) escalates through emitBlockingError at the threshold', async () => {
    settingsUnderTest = { CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: '3', CLAUDE_MEM_HOOK_FAIL_MODE: 'block' };
    await recordWorkerUnreachable();
    await recordWorkerUnreachable();
    expect(blockingCalls).toHaveLength(0); // below threshold: silent
    const count = await recordWorkerUnreachable();
    expect(count).toBe(3);
    expect(blockingCalls).toHaveLength(1);
    expect(blockingCalls[0]).toContain('worker unreachable for 3 consecutive hooks');
    expect(diagnosticCalls).toHaveLength(0);
  });

  it('unset mode falls back to block (existing behavior unchanged)', async () => {
    settingsUnderTest = { CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: '3' };
    seedFailureState(2);
    await recordWorkerUnreachable();
    expect(blockingCalls).toHaveLength(1);
    expect(diagnosticCalls).toHaveLength(0);
  });

  it('warn mode surfaces the same failure through emitDiagnostic and never blocks', async () => {
    settingsUnderTest = { CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: '3', CLAUDE_MEM_HOOK_FAIL_MODE: 'warn' };
    seedFailureState(2);
    const count = await recordWorkerUnreachable();
    expect(count).toBe(3);
    expect(blockingCalls).toHaveLength(0);
    expect(diagnosticCalls).toHaveLength(1);
    expect(diagnosticCalls[0]).toContain('worker unreachable for 3 consecutive hooks');
    expect(diagnosticCalls[0]).toContain('CLAUDE_MEM_HOOK_FAIL_MODE=warn');
  });

  it('warn mode keeps warning on every failure past the threshold (same cadence as block)', async () => {
    settingsUnderTest = { CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: '3', CLAUDE_MEM_HOOK_FAIL_MODE: 'warn' };
    seedFailureState(5);
    await recordWorkerUnreachable();
    await recordWorkerUnreachable();
    expect(diagnosticCalls).toHaveLength(2);
    expect(diagnosticCalls[1]).toContain('worker unreachable for 7 consecutive hooks');
    expect(blockingCalls).toHaveLength(0);
  });

  it('warn mode still increments and persists the failure counter', async () => {
    settingsUnderTest = { CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: '3', CLAUDE_MEM_HOOK_FAIL_MODE: 'warn' };
    seedFailureState(3);
    const count = await recordWorkerUnreachable();
    expect(count).toBe(4);
    const persisted = JSON.parse(
      await Bun.file(join(dataDir, 'state', 'hook-failures.json')).text(),
    ) as { consecutiveFailures: number };
    expect(persisted.consecutiveFailures).toBe(4);
  });
});
