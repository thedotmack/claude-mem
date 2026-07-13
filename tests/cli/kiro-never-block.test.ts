import { describe, it, expect, afterEach } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  setActivePlatform,
  activePlatformNeverBlocks,
  recordWorkerUnreachable,
} from '../../src/shared/worker-utils.js';
import { DATA_DIR } from '../../src/shared/paths.js';

// Kiro never-block invariant: on Kiro CLI, exit 2 has host-side semantics
// (preToolUse exit 2 blocks the user's tool call), so the two fail-loud exit-2
// sites must degrade to stderr diagnostics + exit 0 when the active platform
// is Kiro. Documented in docs/public/kiro-cli/parity.mdx.

const FAILURE_STATE_PATH = join(DATA_DIR, 'state', 'hook-failures.json');

function resetFailureState(): void {
  mkdirSync(join(DATA_DIR, 'state'), { recursive: true });
  writeFileSync(FAILURE_STATE_PATH, JSON.stringify({ consecutiveFailures: 0, lastFailureAt: 0 }));
}

function captureRealStderr(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  return { chunks, restore: () => { process.stderr.write = original as typeof process.stderr.write; } };
}

afterEach(() => {
  setActivePlatform('raw');
  rmSync(FAILURE_STATE_PATH, { force: true });
});

describe('activePlatformNeverBlocks', () => {
  it('is true only for the kiro platform ids', () => {
    setActivePlatform('kiro');
    expect(activePlatformNeverBlocks()).toBe(true);
    setActivePlatform('kiro-cli');
    expect(activePlatformNeverBlocks()).toBe(true);
    setActivePlatform('claude-code');
    expect(activePlatformNeverBlocks()).toBe(false);
    setActivePlatform('raw');
    expect(activePlatformNeverBlocks()).toBe(false);
  });
});

describe('recordWorkerUnreachable on Kiro', () => {
  it('crosses the fail-loud threshold without exiting, emitting a diagnostic instead', async () => {
    resetFailureState();
    setActivePlatform('kiro');
    const stderr = captureRealStderr();
    try {
      // Default threshold is 10; go past it. On non-kiro platforms the
      // threshold call would process.exit(2) — this test COMPLETING past the
      // threshold is the invariant under test.
      let count = 0;
      for (let i = 0; i < 11; i++) {
        count = await recordWorkerUnreachable();
      }
      expect(count).toBe(11);
    } finally {
      stderr.restore();
    }

    const all = stderr.chunks.join('');
    expect(all).toContain('worker unreachable');

    const persisted = JSON.parse(readFileSync(FAILURE_STATE_PATH, 'utf-8'));
    expect(persisted.consecutiveFailures).toBe(11);
  });
});

describe('hookCommand catch-all — never-block source contract', () => {
  it('consults activePlatformNeverBlocks before emitBlockingError in the catch block', () => {
    const source = readFileSync('src/cli/hook-command.ts', 'utf-8');
    const catchRegion = source.slice(source.indexOf('} catch (error) {'));

    const neverBlockIndex = catchRegion.indexOf('activePlatformNeverBlocks()');
    const blockingErrorIndex = catchRegion.indexOf('emitBlockingError(');

    expect(neverBlockIndex).toBeGreaterThan(-1);
    expect(blockingErrorIndex).toBeGreaterThan(-1);
    expect(neverBlockIndex).toBeLessThan(blockingErrorIndex);

    // And the platform is registered at hookCommand entry.
    expect(source).toContain('setActivePlatform(platform)');
  });
});
