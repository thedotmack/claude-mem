import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeTest as test } from './native-prerequisite.js';
import { formatFoldedView, parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

describe('native Markdown heading markers', () => {
  for (const indent of [0, 1, 2, 3]) {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      test(`keeps level ${level} after ${indent} leading spaces`, () => {
        const source = `${' '.repeat(indent)}${'#'.repeat(level)} Heading\n\nbody\n`;
        const headings = parseFile(source, 'heading.md').symbols.filter(s => s.kind === 'section');
        expect(headings.map(s => s.signature)).toEqual([`${'#'.repeat(level)} Heading`]);
      }, 120000);
    }
  }

  for (const [source, expected] of [
    ['> ### Quoted\n>\n> body\n', '### Quoted'],
    ['- #### Listed\n\n  body\n', '#### Listed'],
    ['> Setext\n> ------\n>\n> body\n', '## Setext'],
    ['- Setext\n  ------\n\n  body\n', '## Setext'],
  ]) {
    test(`uses the parsed marker for ${JSON.stringify(source.split('\n')[0])}`, () => {
      expect(parseFile(source, 'container.md').symbols.filter(s => s.kind === 'section').map(s => s.signature)).toEqual([expected]);
    }, 120000);
  }

  test('unfolds an indented section through its children and stops at its sibling', () => {
    const source = '# Root\n\nintro\n\n ## Branch\n\nbranch body\n\n   ### Leaf\n\nleaf body\n\n  ## Sibling\n\nsibling body\n\n# Next\n\nnext body';
    const branch = unfoldSymbol(source, 'tree.md', 'Branch');
    expect(branch).toContain('branch body');
    expect(branch).toContain('leaf body');
    expect(branch).not.toContain('Sibling');
    const root = unfoldSymbol(source, 'tree.md', 'Root');
    expect(root).toContain('sibling body');
    expect(root).not.toContain('# Next');
    const folded = formatFoldedView(parseFile(source, 'tree.md'));
    expect(folded.split('\n').some(line => line.startsWith('      ### Leaf'))).toBe(true);
  }, 120000);

  test('batched search retains the native level in its folded results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-heading-levels-'));
    try {
      writeFileSync(join(dir, 'guide.md'), '# Guide\n\n   ### Configuration\n\nconfiguration details\n');
      const result = await searchCodebase(dir, 'Configuration');
      expect(result.matchingSymbols.find(s => s.symbolName === 'Configuration')?.signature).toBe('### Configuration');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
