import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

it.each([false, true])('keeps real context rendering and HTTP responses available during a native deep scan (probe contention: %s)', (contention) => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-deep-http-'));
  try {
    const child = spawnSync(process.execPath, ['tests/fixtures/deep-search-http-isolation.ts'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dir, CLAUDE_CONFIG_DIR: dir,
        CLAUDE_MEM_MODES_DIR: join(process.cwd(), 'plugin/modes'), CLAUDE_MEM_CHROMA_ENABLED: 'false',
        CLAUDE_MEM_TELEMETRY_ENABLED: 'false', DO_NOT_TRACK: '1',
        CM_TEST_SNAPSHOT_CONTENTION: String(contention) },
    });
    if (child.status !== 0) throw new Error(`Isolation fixture failed (${child.signal}): ${child.stderr.slice(-3000)}`);
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
    expect(result.baseline.texts[0]).toContain('ORDINARY_CONTEXT_RECORD');
    expect(result.underLoad.texts.length).toBeGreaterThan(0);
    for (const text of result.underLoad.texts) expect(text).toBe(result.baseline.texts[0]);
    expect(result.health.ok).toBe(true);
    expect(result.ordinary.observations).toHaveLength(1);
    expect(result.ordinary).not.toHaveProperty('deep');
    expect(result.busy.deep).toEqual({ status: 'busy', complete: false, count: null, hasMore: null });
    expect(result.timeout.deep).toEqual({ status: 'timeout', complete: false, count: null, hasMore: null });
    expect(result.recovery.deep.status).toBe('ok');
    expect(result.recovery.toolUses).toHaveLength(1);
    // Only samples bracketed by an actual pinned read snapshot are reported.
    // No fixed 10-requests-within-600ms assumption or real-corpus p95 claim.
    console.log(JSON.stringify({ contextBaselineMs: result.baseline.times, contextDuringDeepMs: result.underLoad.times }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 70_000);
