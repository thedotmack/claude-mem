import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { buildMemoryObservation, type MemoryDirRef, type MemoryFileRef } from '../../src/services/memory/ingest.js';
import { saveMemory } from '../../src/services/memory/save-memory.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('stored native-memory previews', () => {
  let store: SessionStore;
  beforeEach(() => { store = new SessionStore(':memory:'); });
  afterEach(() => { store.close(); });

  function save(text: string, title?: string) {
    return saveMemory({
      getSessionStore: () => store,
      getCloudSync: () => null,
      getChromaSync: () => null,
    } as any, 'unicode-notes', { text, title });
  }

  it('does not save half of a supplementary character in an inferred title', () => {
    const prefix = 'a'.repeat(59);
    const text = `${prefix}🧠 remember this`;
    const result = save(text);
    expect(store.db.query('SELECT title, narrative FROM observations WHERE id = ?').get(result.id))
      .toEqual({ title: `${prefix}...`, narrative: text });
    expect(result.title).toBe(`${prefix}...`);
  });

  it('retains a complete supplementary character that fits the inferred-title budget', () => {
    const title = `${'a'.repeat(58)}🧠`;
    const result = save(title);
    expect(result.title).toBe(title);
    expect(store.db.query('SELECT title FROM observations WHERE id = ?').get(result.id)).toEqual({ title });
  });

  it('does not shorten an explicitly supplied title', () => {
    const title = `${'a'.repeat(59)}🧠 authored title`;
    const result = save('Full memory narrative.', title);
    expect(result.title).toBe(title);
    expect(store.db.query('SELECT title FROM observations WHERE id = ?').get(result.id)).toEqual({ title });
  });

  for (const [field, limit] of [['title', 200], ['subtitle', 300]] as const) {
    it(`does not store a split supplementary character at the imported ${field} limit`, () => {
      const prefix = 'a'.repeat(limit - 1);
      const input = `${prefix}🧠 imported memory`;
      const file = {
        fileName: 'note.md', title: field === 'title' ? input : 'Imported note',
        body: 'Keep this full narrative 🧠.', mtimeEpoch: 1_700_000_000_000,
        frontmatter: { description: field === 'subtitle' ? input : 'Description' },
      } as MemoryFileRef;
      const observation = buildMemoryObservation({ project: 'unicode-notes', encodedName: '-notes' } as MemoryDirRef, file);
      const session = store.getOrCreateManualSession(observation.project);
      const { id } = store.storeObservation(session, observation.project, {
        ...observation, facts: [], files_read: [], files_modified: [], metadata: JSON.stringify(observation.metadata),
      }, 0, 0, observation.createdAtEpoch);
      const row = store.db.query('SELECT title, subtitle, narrative FROM observations WHERE id = ?').get(id) as Record<string, string>;
      expect(row[field]).toBe(prefix);
      expect(row.narrative).toBe(file.body);

      // A complete character at the same boundary remains present.
      const fits = `${'b'.repeat(limit - 2)}🧠`;
      file.title = field === 'title' ? fits : file.title;
      file.frontmatter.description = field === 'subtitle' ? fits : file.frontmatter.description;
      expect(buildMemoryObservation({ project: 'unicode-notes', encodedName: '-notes' } as MemoryDirRef, file)[field]).toBe(fits);
    });
  }
});
