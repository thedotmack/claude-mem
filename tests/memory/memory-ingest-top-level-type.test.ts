import { describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ingestMemorySource, parseMemoryFrontmatter } from '../../src/services/memory/ingest.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { scratchDir } from '../helpers/scratch-dir.js';

const kinds = ['user', 'feedback', 'project', 'reference'];
const note = (fields: string[], newline = '\n') => ['---', 'name: Deployment note', ...fields, '---', 'Keep the deployment fact.'].join(newline);

describe('memory categories before native metadata stamping', () => {
  for (const kind of kinds) for (const newline of ['\n', '\r\n']) {
    it(`reads a top-level ${kind} category with ${JSON.stringify(newline)} line endings`, () => {
      const parsed = parseMemoryFrontmatter(note([`type: "${kind}"`], newline));
      expect(parsed.frontmatter.type).toBe(kind);
      expect(parsed.body).toBe('Keep the deployment fact.');
    });
  }

  it('does not replace the top-level category with a field in an unrelated mapping', () => {
    const parsed = parseMemoryFrontmatter(note(['type: feedback', 'related:', '  type: reference']));
    expect(parsed.frontmatter.type).toBe('feedback');
  });

  for (const fields of [
    ['type: feedback', 'metadata:', '  type: project'],
    ['metadata:', '  type: project', 'type: feedback'],
  ]) {
    it(`retains the stamped category when both forms exist: ${fields[0]}`, () => {
      expect(parseMemoryFrontmatter(note(fields)).frontmatter.type).toBe('project');
    });
  }

  it('does not infer a category from body text or an unrelated mapping', () => {
    expect(parseMemoryFrontmatter('type: feedback\nPlain note.').frontmatter).toEqual({});
    expect(parseMemoryFrontmatter(note(['related:', '  type: reference'])).frontmatter.type).toBeUndefined();
  });

  it('stores and recalls each category from actual Markdown notes', async () => {
    const root = scratchDir('memory-top-level-type');
    const store = new SessionStore(':memory:');
    try {
      const memory = join(root, 'notes', 'memory');
      mkdirSync(memory, { recursive: true });
      for (const kind of kinds) {
        writeFileSync(join(memory, `${kind}.md`), `---\nname: ${kind} note\ntype: ${kind}\n---\nKeep the ${kind} deployment fact.`);
      }
      const report = await ingestMemorySource(memory, { root }, {
        storeMemoryObservation: async observation => {
          const session = store.getOrCreateManualSession(observation.project);
          const result = store.storeObservation(session, observation.project, {
            ...observation, facts: [], files_read: [], files_modified: [],
            metadata: JSON.stringify(observation.metadata),
          }, 0, 0, observation.createdAtEpoch, undefined, { skipTitleDedup: true });
          return { id: result.id, deduped: result.mergedIntoExisting };
        },
      });
      expect(report.stored).toBe(4);
      expect(report.failed).toBe(0);
      const search = new SessionSearch(store.db);
      for (const kind of kinds) {
        const rows = search.findByConcept(`memory-type:${kind}`);
        expect(rows.map(row => row.title)).toEqual([`${kind} note`]);
        expect(JSON.parse(rows[0].metadata!)).toMatchObject({ memoryType: kind });
        expect(rows[0].narrative).toBe(`Keep the ${kind} deployment fact.`);
      }
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
