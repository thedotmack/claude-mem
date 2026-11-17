import { describe, expect, it } from 'bun:test';
import { observationSyncBodyBound } from '../../../src/npx-cli/commands/import-memory.js';
import { saveMemory } from '../../../src/services/memory/save-memory.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { getNativeContentOperation } from '../../../src/services/sync/CloudSync.js';
import { CONTENT_BODY_MAX_BYTES, ORIGIN_DEVICE_ID_MAX_BYTES } from '../../../src/shared/cloud-sync-limits.js';
import { KEPT_NOTE_RECORD_REST_BYTES, jsonTextBytes, keptNoteText, noteFor, type MemoryResult } from '../../../src/ui/my-work/src/setup/setup-search.ts';

/**
 * Setup's "What's next?" screen keeps a search result as a note (POST /api/memory/save). The note is cut so the memory
 * it becomes is still one record cloud sync accepts (CONTENT_BODY_MAX_BYTES); a larger one is quarantined and never
 * leaves this computer. These tests save cut notes through the real save path and build their real synced records with
 * the real CloudSync code, at the longest device id, with text whose characters take 1 to 6 bytes.
 */
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const LONGEST_DEVICE_ID = '\u0000'.repeat(ORIGIN_DEVICE_ID_MAX_BYTES);
const record = (changes: Partial<MemoryResult> = {}): MemoryResult => ({
  id: 'observation-1', title: 'Signup screens ready for review', body: 'b', project: 'onboarding', agent: 'Codex', session: 'abc', date: '2026-10-21', ...changes,
});
/** The sync's worst case for the record a kept note becomes: no metadata, so `null` where the importer's notes have some. */
function syncBound(note: ReturnType<typeof noteFor>) {
  const bound = observationSyncBodyBound({ ...note, metadata: {} }) as { payload: Record<string, unknown> };
  bound.payload.metadata = null;
  return bound;
}
function saveAndBuild(note: ReturnType<typeof noteFor>): string {
  const store = new SessionStore(':memory:');
  const manager = { getConnection: () => store.db, getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null };
  try {
    const saved = saveMemory(manager as any, 'default-project', note);
    return getNativeContentOperation(store.db, 'observation', String(saved.id), LONGEST_DEVICE_ID)!.operation.body;
  } finally { store.close(); }
}

describe('a kept note stays one record cloud sync accepts', () => {
  it('reserves at least what the rest of the record takes at its longest', () => {
    // An empty title still reads "Note: " (noteFor); its 6 bytes are the note's own, its quotes the rest's.
    const rest = bytes(syncBound(noteFor(record({ title: '', project: '' }), ''))) - jsonTextBytes('Note: ');
    expect(KEPT_NOTE_RECORD_REST_BYTES).toBeGreaterThanOrEqual(rest);
    console.log(`rest of a kept note's record at its longest: ${rest} bytes; reserved: ${KEPT_NOTE_RECORD_REST_BYTES}`);
  });

  // Titles and projects with quotes, accents and CJK; text of CJK (3 bytes), emoji (4), newlines (2), control characters (6).
  const cases: Array<[string, MemoryResult, string]> = [
    ['CJK and emoji', record(), '日本語の記録😀'.repeat(40_000)],
    ['escapes', record({ title: 'Notes on "quotes" and \\ slashes', project: 'projet-é' }), 'line\n\u0001"'.repeat(60_000)],
    ['a long title and project', record({ title: '設計の決定 '.repeat(60), project: 'クライアント-ポータル'.repeat(8) }), 'é'.repeat(140_000)],
  ];
  for (const [name, source, paste] of cases) {
    it(`cuts a pasted note to the most that still syncs: ${name}`, () => {
      const kept = keptNoteText(source, paste);
      expect(kept.cut).toBe(true);
      const note = noteFor(source, kept.text);
      // The worst case fits exactly, and one more character would not.
      expect(bytes(syncBound(note))).toBeLessThanOrEqual(CONTENT_BODY_MAX_BYTES);
      const next = String.fromCodePoint(paste.codePointAt(kept.text.length)!);
      expect(bytes(syncBound(noteFor(source, kept.text + next)))).toBeGreaterThan(CONTENT_BODY_MAX_BYTES);
      // The real record: built by the sync (which refuses an oversized one) and within the limit.
      expect(Buffer.byteLength(saveAndBuild(note))).toBeLessThanOrEqual(CONTENT_BODY_MAX_BYTES);
    });
  }

  it('would have let through a note the sync refuses without the cut (the old 862,890-character cap)', () => {
    const uncut = noteFor(record(), 'x'.repeat(CONTENT_BODY_MAX_BYTES));
    expect(() => saveAndBuild(uncut)).toThrow(/exceeds/);
  });
});
