import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ingestMemorySource,
  parseMemoryFrontmatter,
  type MemoryObservationToStore,
} from '../../src/services/memory/ingest.js';

describe('memory frontmatter closing delimiter', () => {
  for (const [label, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    const lines = [
      '---',
      'name: release-notes',
      'description: |',
      '  Keep the deployment sequence.',
      '  ---',
      '  Keep the rollback sequence too.',
      'metadata:',
      '  type: project',
      '  originSessionId: release-session',
      '---',
      '# Deployment',
      'Run the migration before restarting the worker.',
    ];
    const body = lines.slice(10).join(newline);

    it(`ignores an indented separator inside frontmatter (${label})`, () => {
      const result = parseMemoryFrontmatter(lines.join(newline));
      expect(result.body).toBe(body);
      expect(result.frontmatter).toMatchObject({
        name: 'release-notes', type: 'project', originSessionId: 'release-session',
      });
    });

    it(`preserves an unterminated block with an indented separator (${label})`, () => {
      const raw = lines.slice(0, 9).join(newline);
      expect(parseMemoryFrontmatter(raw)).toEqual({ frontmatter: {}, body: raw });
    });

    it(`stores the body and metadata after the real closing delimiter (${label})`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'cm-frontmatter-close-'));
      try {
        const project = join(root, '-work-release');
        const memory = join(project, 'memory');
        mkdirSync(memory, { recursive: true });
        writeFileSync(join(project, 'release-session.jsonl'), JSON.stringify({
          type: 'user', cwd: '/work/release', message: { content: 'release the worker' },
        }) + '\n');
        writeFileSync(join(memory, 'deployment.md'), lines.join(newline));
        const stored: MemoryObservationToStore[] = [];
        const report = await ingestMemorySource(memory, { root }, {
          storeMemoryObservation: async observation => {
            stored.push(observation);
            return { id: stored.length, deduped: false };
          },
        });
        expect(report.stored).toBe(1);
        expect(stored).toHaveLength(1);
        expect(stored[0].narrative).toBe(body);
        expect(stored[0].concepts).toContain('memory-type:project');
        expect(stored[0].metadata.originSessionId).toBe('release-session');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
