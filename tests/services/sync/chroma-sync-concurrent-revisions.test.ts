import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = join(import.meta.dir, 'fixtures/concurrent-revision.ts');
const repo = join(import.meta.dir, '../../..');

function run(dir: string, kind: string, schedule: string, restart = false, failRevision = false, throwLookup = false) {
  const result = Bun.spawnSync([process.execPath, fixture], {
    cwd: repo,
    env: { ...process.env, CLAUDE_MEM_DATA_DIR: dir, CLAUDE_CONFIG_DIR: join(dir, 'config'),
      CHROMA_ROW_KIND: kind, CHROMA_ROW_SCHEDULE: schedule, CHROMA_ROW_RESTART: restart ? '1' : '0',
      CHROMA_FAIL_REVISION: failRevision ? '1' : '0', CHROMA_THROW_LOOKUP: throwLookup ? '1' : '0', CHROMA_ROW_LIVE: '0' },
    stdout: 'pipe', stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
}

function expectCurrent(result: any) {
  const text = result.documents.map((doc: { document: string }) => doc.document).join('\n');
  expect(text).toContain('new green cluster');
  expect(text).not.toContain('retired blue cluster');
  expect(text).not.toContain('obsolete credential');
  expect(result.pending).toEqual([]);
}

describe('backfill and live memory revisions share one row writer', () => {
  for (const kind of ['observation', 'summary', 'prompt']) {
    it(`reads the current ${kind} when a revision finishes before its backfill turn`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroma-current-revision-'));
      try {
        const result = run(dir, kind, 'before-turn');
        expect(result.row.sync_rev).toBe('2');
        expect(result.outcome).toBe('completed');
        expect(result.unrelatedProgressed).toBe(true);
        expect(result.revisionFinishedBeforeRelease).toBe(true);
        expectCurrent(result);
        const recovered = run(dir, kind, 'before-turn', true);
        expectCurrent(recovered);
        expect(recovered.targetMutations).toBe(0);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  for (const kind of ['observation', 'summary']) {
    it(`keeps all ${kind} batches and cleanup ordered across ChromaSync instances`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroma-ordered-revision-'));
      try {
        const result = run(dir, kind, 'during-row');
        expect(result.row.sync_rev).toBe('2');
        expect(result.unrelatedProgressed).toBe(true);
        expect(result.revisionFinishedBeforeRelease).toBe(false);
        expectCurrent(result);
        expectCurrent(run(dir, kind, 'during-row', true));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  for (const kind of ['observation', 'summary', 'prompt']) {
    for (const schedule of ['queued-rehome', 'waiting-rehome']) {
      it(`uses the current ${kind} project after a remap while ${schedule}`, () => {
        const dir = mkdtempSync(join(tmpdir(), 'chroma-rehomed-revision-'));
        try {
          const result = run(dir, kind, schedule);
          expect(result.row.project).toBe('rehome-project');
          expectCurrent(result);
          expect(result.documents.every((doc: any) => doc.metadata.project === 'rehome-project')).toBe(true);
          const recovered = run(dir, kind, schedule, true);
          expectCurrent(recovered);
          expect(recovered.documents.every((doc: any) => doc.metadata.project === 'rehome-project')).toBe(true);
          expect(recovered.targetMutations).toBe(0);
        } finally { rmSync(dir, { recursive: true, force: true }); }
      });
    }
  }

  it('preserves a failed newer revision for recovery in a fresh process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroma-revision-recovery-'));
    try {
      const result = run(dir, 'observation', 'during-row', false, true);
      expect(result.row.sync_rev).toBe('2');
      expect(result.pending).toContain(result.targetId);
      const recovered = run(dir, 'observation', 'during-row', true);
      expectCurrent(recovered);
      expect(recovered.targetMutations).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('releases the row writer after a thrown fragment lookup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroma-revision-cleanup-error-'));
    try {
      const result = run(dir, 'observation', 'during-row', false, false, true);
      expect(result.rejectedForwards).toBe(1);
      expect(result.row.sync_rev).toBe('3');
      expectCurrent(result);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps the supplied platform for a prompt without a session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroma-current-orphan-prompt-'));
    try {
      const result = run(dir, 'prompt', 'orphan-prompt');
      expect(result.row.session_db_id).toBeNull();
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.platform_source).toBe('codex');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
