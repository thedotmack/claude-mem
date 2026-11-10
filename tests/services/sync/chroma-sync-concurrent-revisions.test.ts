import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runConcurrentRevision as run } from './fixtures/concurrent-revision.js';

function expectCurrent(result: any) {
  const text = result.documents.map((doc: { document: string }) => doc.document).join('\n');
  expect(text).toContain('new green cluster');
  expect(text).not.toContain('retired blue cluster');
  expect(text).not.toContain('obsolete credential');
  expect(result.pending).toEqual([]);
}

describe('backfill and live memory revisions share one row writer', () => {
  for (const kind of ['observation', 'summary', 'prompt']) {
    it(`reads the current ${kind} when a revision finishes before its backfill turn`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroma-current-revision-'));
      try {
        const result = await run(dir, kind, 'before-turn');
        expect(result.row.sync_rev).toBe('2');
        expect(result.outcome).toBe('completed');
        expect(result.unrelatedProgressed).toBe(true);
        expect(result.revisionFinishedBeforeRelease).toBe(true);
        expectCurrent(result);
        const recovered = await run(dir, kind, 'before-turn', true);
        expectCurrent(recovered);
        expect(recovered.targetMutations).toBe(0);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  for (const kind of ['observation', 'summary']) {
    it(`keeps all ${kind} batches and cleanup ordered across ChromaSync instances`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'chroma-ordered-revision-'));
      try {
        const result = await run(dir, kind, 'during-row');
        expect(result.row.sync_rev).toBe('2');
        expect(result.unrelatedProgressed).toBe(true);
        expect(result.revisionFinishedBeforeRelease).toBe(false);
        expectCurrent(result);
        expectCurrent(await run(dir, kind, 'during-row', true));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  for (const kind of ['observation', 'summary', 'prompt']) {
    for (const schedule of ['queued-rehome', 'waiting-rehome']) {
      it(`uses the current ${kind} project after a remap while ${schedule}`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'chroma-rehomed-revision-'));
        try {
          const result = await run(dir, kind, schedule);
          expect(result.row.project).toBe('rehome-project');
          expectCurrent(result);
          expect(result.documents.every((doc: any) => doc.metadata.project === 'rehome-project')).toBe(true);
          const recovered = await run(dir, kind, schedule, true);
          expectCurrent(recovered);
          expect(recovered.documents.every((doc: any) => doc.metadata.project === 'rehome-project')).toBe(true);
          expect(recovered.targetMutations).toBe(0);
        } finally { rmSync(dir, { recursive: true, force: true }); }
      });
    }
  }

  it('preserves a failed newer revision for recovery after the state cache resets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroma-revision-recovery-'));
    try {
      const result = await run(dir, 'observation', 'during-row', false, true);
      expect(result.row.sync_rev).toBe('2');
      expect(result.pending).toContain(result.targetId);
      const recovered = await run(dir, 'observation', 'during-row', true);
      expectCurrent(recovered);
      expect(recovered.targetMutations).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('releases the row writer after a thrown fragment lookup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroma-revision-cleanup-error-'));
    try {
      const result = await run(dir, 'observation', 'during-row', false, false, true);
      expect(result.rejectedForwards).toBe(1);
      expect(result.row.sync_rev).toBe('3');
      expectCurrent(result);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps the supplied platform for a prompt without a session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroma-current-orphan-prompt-'));
    try {
      const result = await run(dir, 'prompt', 'orphan-prompt');
      expect(result.row.session_db_id).toBeNull();
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].metadata.platform_source).toBe('codex');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
