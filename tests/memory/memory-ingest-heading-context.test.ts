import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveTitle, ingestMemorySource, type MemoryObservationToStore } from '../../src/services/memory/ingest.js';

describe('native memory titles outside code examples', () => {
  const cases = [
    {
      name: 'shell comments do not outrank the real H2',
      body: '```sh\n# Restart the development server\nnpm run dev\n```\n\n## Deployment notes\nUse the staged environment.',
      title: 'Deployment notes',
    },
    {
      name: 'tilde-fenced comments do not outrank the real H1',
      body: '~~~python\n# Decode the response\nresult = response.json()\n~~~\n\n# API decisions',
      title: 'API decisions',
    },
    {
      name: 'a short fence cannot close a longer example',
      body: '````markdown\n```sh\n# Example heading\n```\n## Still an example\n````\n\n## Markdown conventions',
      title: 'Markdown conventions',
    },
    {
      name: 'the closing fence must match its opening character',
      body: '~~~\n```\n# Still literal\n~~~\n\n## Real heading',
      title: 'Real heading',
    },
    {
      name: 'an unterminated fence keeps the remaining comments literal',
      body: 'Notes without a heading.\n\n```sh\n# A shell comment\n## Another comment',
      title: 'fallback',
    },
    {
      name: 'indented top-level fences still hide unindented code',
      body: '   ```sh\n# Example comment\n   ```\n\n## Actual title',
      title: 'Actual title',
    },
    {
      name: 'leaving a list container also ends its unclosed fence',
      body: '- Example\n\n  ```sh\n  # List example\n\n# After the list',
      title: 'After the list',
    },
    {
      name: 'a backtick in the info text does not open a fence',
      body: '```example `inline`\n# A real heading',
      title: 'A real heading',
    },
    {
      name: 'an HTML comment is not a heading',
      body: '<!--\n# Internal comment\n-->\n\n## Visible topic',
      title: 'Visible topic',
    },
    {
      name: 'a later H1 still outranks an earlier H2',
      body: '## Earlier subsection\n\n# Main topic\n\n# Later heading',
      title: 'Main topic',
    },
    {
      name: 'existing title spelling stays unchanged',
      body: '# Keep **this** `API` title ###\n',
      title: 'Keep **this** `API` title ###',
    },
    {
      name: 'source offsets preserve Unicode before and inside the title',
      body: '🧭 记录部署决策\n\n```sh\n# 示例注释\n```\n\n# 上线策略 🚀',
      title: '上线策略 🚀',
    },
    {
      name: 'a valid indented H1 still has priority over H2',
      body: '## Earlier section\n\n   # Indented main title\n\n## Later section',
      title: 'Indented main title',
    },
  ];

  for (const newline of ['\n', '\r\n']) {
    for (const example of cases) {
      it(`${example.name} (${JSON.stringify(newline)})`, () => {
        expect(deriveTitle('fallback.md', {}, example.body.replaceAll('\n', newline))).toBe(example.title);
      });
    }
  }

  it('keeps an explicit frontmatter name ahead of headings and code', () => {
    expect(deriveTitle('fallback.md', { name: ' Named topic ' }, '```sh\n# Comment\n```\n# Heading'))
      .toBe('Named topic');
  });

  it('passes the real title and unmodified example narrative to the memory store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-heading-context-'));
    const memory = join(root, 'project', 'memory');
    mkdirSync(memory, { recursive: true });
    const body = '```sh\n# This is an example comment\necho ready\n```\n\n## Deployment decisions\nKeep the old endpoint available.';
    writeFileSync(join(memory, 'deployment.md'), body);
    const saved: MemoryObservationToStore[] = [];
    try {
      const report = await ingestMemorySource(memory, { root }, {
        storeMemoryObservation: async observation => {
          saved.push(observation);
          return { id: saved.length, deduped: false };
        },
      });
      expect(report.stored).toBe(1);
      expect(saved).toHaveLength(1);
      expect(saved[0].title).toBe('Deployment decisions');
      expect(saved[0].narrative).toBe(body);
      expect(saved[0].sourceFile).toBe('deployment.md');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
