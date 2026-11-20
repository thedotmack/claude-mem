import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestMemorySource, parseMemoryFrontmatter, type MemoryObservationToStore } from '../../src/services/memory/ingest.js';

describe('UTF-8 native memory notes', () => {
  for (const newline of ['\n', '\r\n']) {
    it(`reads BOM-prefixed frontmatter with ${JSON.stringify(newline)} line endings`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'native-memory-bom-'));
      const memory = join(root, 'project', 'memory');
      mkdirSync(memory, { recursive: true });
      const frontmatter = ['---', 'name: Named memory', 'description: Project decision', 'metadata:', '  type: project', '  originSessionId: original-session', '---'].join(newline);
      writeFileSync(join(memory, 'named.md'), '\uFEFF' + frontmatter + newline + 'Keep the parser incremental.');
      writeFileSync(join(memory, 'empty.md'), '\uFEFF' + frontmatter + newline);
      writeFileSync(join(memory, 'heading.md'), '\uFEFF# Heading memory' + newline + 'Use a stable cursor.');
      const saved: MemoryObservationToStore[] = [];
      try {
        const report = await ingestMemorySource(memory, { root }, {
          storeMemoryObservation: async observation => {
            saved.push(observation);
            return { id: saved.length, deduped: false };
          },
        });
        expect(report.stored).toBe(2);
        expect(report.skipped).toBe(1);
        const named = saved.find(observation => observation.title === 'Named memory');
        expect(named).toBeDefined();
        expect(named?.narrative).toBe('Keep the parser incremental.');
        expect(named?.subtitle).toBe('Project decision');
        expect(named?.metadata).toMatchObject({ memoryType: 'project', originSessionId: 'original-session' });
        expect(saved.some(observation => observation.title === 'Heading memory')).toBe(true);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  it('keeps non-frontmatter body text and non-leading BOM characters', () => {
    const body = '  ---\nname: prose\n---\nA\uFEFFB';
    expect(parseMemoryFrontmatter('\uFEFF' + body)).toEqual({ frontmatter: {}, body });
  });
});
