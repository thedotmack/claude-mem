import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestMemorySource, parseMemoryFrontmatter } from '../../src/services/memory/ingest.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const expected = { name: 'Scoped note', type: 'project', originSessionId: 'owner-session', nodeType: 'memory' };

function note(lines: string[], newline = '\n'): string {
  return ['---', 'name: Scoped note', ...lines, '---', 'Keep the original session attribution.'].join(newline);
}

describe('native memory metadata ownership', () => {
  for (const indent of ['  ', '    ']) {
    for (const newline of ['\n', '\r\n']) {
      const suffix = `(${indent.length} spaces, ${JSON.stringify(newline)})`;
      const fields = [
        `${indent}type: project`,
        `${indent}originSessionId: owner-session`,
        `${indent}node_type: memory`,
      ];
      const nested = [
        `${indent}${indent}type: feedback`,
        `${indent}${indent}originSessionId: related-session`,
        `${indent}${indent}node_type: document`,
      ];

      it(`does not promote fields from a nested mapping ${suffix}`, () => {
        const raw = note(['metadata:', ...fields, `${indent}related:`, ...nested], newline);
        expect(parseMemoryFrontmatter(raw).frontmatter).toEqual(expected);
      });

      it(`does not parse block-scalar examples as metadata fields ${suffix}`, () => {
        const raw = note(['metadata:', ...fields, `${indent}example: |`, ...nested], newline);
        expect(parseMemoryFrontmatter(raw).frontmatter).toEqual(expected);
      });

      it(`keeps metadata open across unindented YAML comments ${suffix}`, () => {
        const raw = note(['metadata:', fields[0], '# provenance: the producing session', ...fields.slice(1)], newline);
        expect(parseMemoryFrontmatter(raw).frontmatter).toEqual(expected);
      });

      it(`derives the mapping depth from an unknown direct member ${suffix}`, () => {
        const raw = note(['metadata:', `${indent}related:`, ...nested, ...fields], newline);
        expect(parseMemoryFrontmatter(raw).frontmatter).toEqual(expected);
      });
    }
  }

  it('ignores comment keys before inferring metadata indentation', () => {
    const raw = note([
      'metadata:',
      ' # type: a comment at a different indentation',
      '  type: project',
      '  # originSessionId: a commented-out value',
      '  originSessionId: owner-session',
      '  node_type: memory',
    ]);
    expect(parseMemoryFrontmatter(raw).frontmatter).toEqual(expected);
  });

  it('does not take fields from a following top-level mapping', () => {
    const raw = note([
      'metadata:',
      '  type: project',
      '  originSessionId: owner-session',
      '  node_type: memory',
      'related:',
      '  type: feedback',
      '  originSessionId: related-session',
      '  node_type: document',
    ]);
    expect(parseMemoryFrontmatter(raw).frontmatter).toEqual(expected);
  });

  it('does not manufacture a note type or session from nested-only fields', () => {
    const raw = note([
      'metadata:',
      '  related:',
      '    type: feedback',
      '    originSessionId: related-session',
      '    node_type: document',
    ]);
    expect(parseMemoryFrontmatter(raw).frontmatter).toEqual({ name: 'Scoped note' });
  });

  it('stores the note kind and original session without nested-field contamination', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-metadata-scope-'));
    const store = new SessionStore(':memory:');
    try {
      const memory = join(root, 'project', 'memory');
      mkdirSync(memory, { recursive: true });
      writeFileSync(join(memory, 'scoped.md'), note([
        'metadata:',
        '  type: project',
        '  originSessionId: owner-session',
        '  node_type: memory',
        '  related:',
        '    type: feedback',
        '    originSessionId: related-session',
        '    node_type: document',
      ]));
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
      expect(report.stored).toBe(1);
      expect(report.failed).toBe(0);
      const row = store.db.query('SELECT concepts, metadata, narrative FROM observations').get() as {
        concepts: string; metadata: string; narrative: string;
      };
      expect(JSON.parse(row.concepts)).toEqual(['memory-import', 'memory-type:project']);
      expect(JSON.parse(row.metadata)).toMatchObject({ memoryType: 'project', originSessionId: 'owner-session' });
      expect(row.narrative).toBe('Keep the original session attribution.');
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
