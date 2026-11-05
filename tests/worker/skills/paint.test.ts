import { expect, test } from 'bun:test';
import { applyPaintEdit, readPaintDocument } from '../../../src/shared/skill-paint.js';

const prefix = '\uFEFF---\r\n# author comment\r\nname: tea\r\ndescription: "do: tea"\r\nother: [one, two]\r\n---\r\n';
const body = '## Tea\r\n\r\n1. Fill.\r\n2. Heat.\r\n3. Pour.\r\n\r\nLeave the cup here.';

test('body-only, BOM, empty and commented front matter stay outside whole-block operations', () => {
  for (const header of ['', '\uFEFF', '---\n---\n', prefix]) {
    const { blocks, prefix: actual } = readPaintDocument(header + body);
    expect(actual).toBe(header);
    expect(blocks.map(block => block.markdown).join('')).toBe(body);
    expect(applyPaintEdit(header + body, 6, 6, { tool: 'pencil', markdown: 'Save the cup.  ' }))
      .toBe(header + body.replace('Leave the cup here.', 'Save the cup.  '));
  }
  expect(() => readPaintDocument('---\ninvalid header')).toThrow();
});

test('More and Less adjust heading levels and ordered list positions within their section', () => {
  expect(applyPaintEdit(prefix + body, 0, 0, { tool: 'more' })).toBe(prefix + body.replace('## Tea', '# Tea'));
  expect(applyPaintEdit(body, 0, 0, { tool: 'less' })).toBe(body.replace('## Tea', '### Tea'));
  const reordered = body.replace('1. Fill.\r\n2. Heat.\r\n3. Pour.', '1. Pour.\r\n2. Fill.\r\n3. Heat.');
  expect(applyPaintEdit(body, 4, 4, { tool: 'more' })).toBe(reordered);
  expect(applyPaintEdit(body, 2, 3, { tool: 'less' })).toBe(reordered);
});

test('Human and Einstein replace only the selected passage, matching CRLF and the original EOF', () => {
  expect(applyPaintEdit(prefix + body, 2, 4, { tool: 'human', markdown: 'Boil the water, then pour.' }))
    .toBe(prefix + '## Tea\r\n\r\nBoil the water, then pour.\r\n\r\nLeave the cup here.');
  expect(applyPaintEdit(body, 6, 6, { tool: 'einstein', markdown: 'Keep the cup still.\n\nHot water spills.' }))
    .toBe(body.replace('Leave the cup here.', 'Keep the cup still.\r\n\r\nHot water spills.'));
});

test('Eraser removes precisely the selected content; Pencil leaves adjacent fenced code and trailing spaces intact', () => {
  expect(applyPaintEdit(prefix + body, 2, 4, { tool: 'eraser' })).toBe(prefix + '## Tea\r\n\r\nLeave the cup here.');
  const fenced = 'Before.\r\n\r\n```bash\r\n# code\r\n```\r\n\r\nAfter.\n';
  expect(readPaintDocument(fenced).blocks[2].kind).toBe('code');
  expect(applyPaintEdit(fenced, 0, 0, { tool: 'pencil', markdown: 'Prior.  \nFollow.' }))
    .toBe(fenced.replace('Before.', 'Prior.  \r\nFollow.'));
  expect(() => applyPaintEdit(body, 2, 4, { tool: 'pencil', markdown: 'new' })).toThrow();
  expect(() => applyPaintEdit(body, 1, 1, { tool: 'eraser' })).toThrow();
});
