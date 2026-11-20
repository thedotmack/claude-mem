import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ingestMemorySource, parseMemoryFrontmatter } from '../../src/services/memory/ingest.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('quoted native-memory frontmatter', () => {
  let root: string;
  let store: SessionStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memory-quoted-'));
    store = new SessionStore(':memory:');
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  for (const [name, newline] of [['LF', '\n'], ['CRLF', '\r\n']] as const) {
    it(`stores decoded metadata from a ${name} note while keeping its prose literal`, async () => {
      const projectDir = join(root, '-work-notes');
      const memoryDir = join(projectDir, 'memory');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(projectDir, 'session.jsonl'), JSON.stringify({ cwd: '/work/notes' }) + '\n');
      const prose = String.raw`Keep the example \u4E2D and Don''t literally in the body.`;
      const note = [
        '---',
        `name: 'Don''t forget "cache"'`,
        String.raw`description: "Keep \"quotes\", C:\\cache and \u4E2D\u6587 \U0001F332."`,
        'metadata:',
        String.raw`  node_type: "mem\x6Fry"`,
        String.raw`  type: "proj\u0065ct"`,
        `  originSessionId: 'session''s-origin'`,
        '---',
        prose,
      ].join(newline);
      writeFileSync(join(memoryDir, 'cache.md'), note);

      const report = await ingestMemorySource(memoryDir, { root }, {
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
      const row = store.db.query('SELECT title, subtitle, narrative, concepts, metadata FROM observations').get() as {
        title: string; subtitle: string; narrative: string; concepts: string; metadata: string;
      };
      expect(row.title).toBe('Don\'t forget "cache"');
      expect(row.subtitle).toBe('Keep "quotes", C:\\cache and 中文 🌲.');
      expect(row.narrative).toBe(prose);
      expect(JSON.parse(row.concepts)).toEqual(['memory-import', 'memory-type:project']);
      expect(JSON.parse(row.metadata)).toMatchObject({ memoryType: 'project', originSessionId: "session's-origin" });
      expect(parseMemoryFrontmatter(note).frontmatter.nodeType).toBe('memory');
    });
  }

  it('decodes the YAML named escapes in a single-line double-quoted value', () => {
    const raw = String.raw`---
description: "\0\a\b\t\n\v\f\r\e\ \"\/\\\N\_\L\P"
---
Body`;
    expect(parseMemoryFrontmatter(raw).frontmatter.description)
      .toBe('\0\x07\b\t\n\v\f\r\x1b "/\\\u0085\u00a0\u2028\u2029');
  });

  it('only unescapes doubled apostrophes in single-quoted values', () => {
    const raw = String.raw`---
name: 'Don''t decode \n, \u4E2D or "quotes" here'
---
Body`;
    expect(parseMemoryFrontmatter(raw).frontmatter.name).toBe(String.raw`Don't decode \n, \u4E2D or "quotes" here`);
  });

  it('does not decode an escaped backslash a second time', () => {
    const raw = String.raw`---
name: "literal \\n and \\u4E2D, then \u4E2D"
---
Body`;
    expect(parseMemoryFrontmatter(raw).frontmatter.name).toBe('literal \\n and \\u4E2D, then 中');
  });

  it('retains malformed and unknown escapes instead of throwing away the note', () => {
    const value = String.raw`keep \q \xG1 \u12 \U00110000 \uD800 \UFFFFFFFF`;
    const { frontmatter, body } = parseMemoryFrontmatter(`---\nname: "${value}"\n---\nStill useful prose.`);
    expect(frontmatter.name).toBe(value);
    expect(body).toBe('Still useful prose.');
  });

  it('leaves unquoted values and unmatched quote marks literal', () => {
    const raw = String.raw`---
name: Don''t decode \n or \u4E2D
description: "incomplete \u4E2D
---
Body`;
    expect(parseMemoryFrontmatter(raw).frontmatter).toEqual({
      name: String.raw`Don''t decode \n or \u4E2D`,
      description: String.raw`"incomplete \u4E2D`,
    });
  });
});
