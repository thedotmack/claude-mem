// Run with `npm test`. A stage's Markdown as the reader lays it out (components/stage-reader.tsx).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseInline, parseMarkdown, safeImageSrc, safeLinkHref, type Block, type Inline } from './stage-markdown.ts'

/** The tree as short text, so a test reads like the document. */
const inline = (inlines: Inline[]): string => inlines.map((entry) => {
  switch (entry.kind) {
    case 'text': return entry.text
    case 'code': return `\`${entry.text}\``
    case 'strong': return `<b>${inline(entry.children)}</b>`
    case 'em': return `<i>${inline(entry.children)}</i>`
    case 'link': return `<a ${entry.href}>${inline(entry.children)}</a>`
    case 'image': return `<img ${entry.src} "${entry.alt}">`
  }
}).join('')
const shape = (blocks: Block[]): unknown[] => blocks.map((block) => {
  switch (block.kind) {
    case 'heading': return [`h${block.level}`, inline(block.children)]
    case 'paragraph': return ['p', inline(block.children)]
    case 'code': return ['code', block.language, block.text]
    case 'quote': return ['quote', shape(block.children)]
    case 'list': return [block.ordered ? `ol${block.start}` : 'ul', block.items.map(shape)]
    case 'table': return ['table', block.head.map(inline), block.rows.map((row) => row.map(inline))]
    case 'rule': return ['rule']
  }
})

describe('which addresses a stage may use', () => {
  it('follows a link to http, https or a path on the page\'s own origin, and nothing else', () => {
    assert.deepEqual(['https://example.com/a?b=1', 'HTTP://example.com', '/api/deliverables/3/stage-a-brief.md', 'notes/a.md', '#top'].map(safeLinkHref), ['https://example.com/a?b=1', 'HTTP://example.com', '/api/deliverables/3/stage-a-brief.md', 'notes/a.md', '#top'])
    for (const refused of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/hosts', '//evil.example/x', '/\\evil.example', 'mailto:a@example.com', '']) assert.equal(safeLinkHref(refused), null, refused)
  })
  it('loads an image only from the page\'s own origin: never another site, never data:', () => {
    assert.deepEqual(['/api/media/12/viewer', '/api/deliverables/3/shot.webp', 'sample-stage-evidence.svg'].map(safeImageSrc), ['/api/media/12/viewer', '/api/deliverables/3/shot.webp', 'sample-stage-evidence.svg'])
    for (const refused of ['https://tracker.example/pixel.png', 'http://example.com/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '//cdn.example/a.png']) assert.equal(safeImageSrc(refused), null, refused)
  })
})

describe('inline Markdown', () => {
  it('reads code, bold, italic and links, and leaves a snake_case word alone', () => {
    assert.equal(inline(parseInline('Use `npm test`, **not** *that*, see [the PR](https://example.com/pr/1) for snake_case_names.')), 'Use `npm test`, <b>not</b> <i>that</i>, see <a https://example.com/pr/1>the PR</a> for snake_case_names.')
    assert.equal(inline(parseInline('<https://example.com/x> and \\*not emphasis\\*')), '<a https://example.com/x>https://example.com/x</a> and *not emphasis*')
  })
  it('keeps the words of a link whose address is refused, and never the address', () => {
    assert.equal(inline(parseInline('[click me](javascript:alert(1)) and [data](data:text/html,x)')), 'click me and data')
  })
  it('shows a worker image as an image, an image from another site as a link, and a refused one as its words', () => {
    assert.equal(inline(parseInline('![the board](/api/media/7/viewer "title")')), '<img /api/media/7/viewer "the board">')
    assert.equal(inline(parseInline('![chart](https://example.com/c.png)')), '<a https://example.com/c.png>chart</a>')
    assert.equal(inline(parseInline('![x](data:image/svg+xml,<svg onload=alert(1)>)')), 'x')
  })
  it('keeps raw HTML as text: a tag is letters, not an element', () => {
    const parsed = parseInline('<script>alert(1)</script> <img src=x onerror=alert(1)> <b>bold</b>')
    assert.deepEqual(parsed, [{ kind: 'text', text: '<script>alert(1)</script> <img src=x onerror=alert(1)> <b>bold</b>' }])
  })
})

describe('Markdown blocks', () => {
  it('reads headings, paragraphs, a quote, a rule and fenced code with its language', () => {
    const blocks = parseMarkdown('# Title\n\nFirst line\nsecond line\n\n> "the ask"\n> more\n\n---\n\n```ts\nconst a = 1\n<b>not html</b>\n```\n')
    assert.deepEqual(shape(blocks), [['h1', 'Title'], ['p', 'First line\nsecond line'], ['quote', [['p', '"the ask"\nmore']]], ['rule'], ['code', 'ts', 'const a = 1\n<b>not html</b>']])
  })
  it('reads lists, ordered from their first number, with a list nested under an item', () => {
    assert.deepEqual(shape(parseMarkdown('- one\n- two\n  - inner\n- three\n\n3. third\n4. fourth\n')), [
      ['ul', [[['p', 'one']], [['p', 'two'], ['ul', [[['p', 'inner']]]]], [['p', 'three']]]],
      ['ol3', [[['p', 'third']], [['p', 'fourth']]]],
    ])
  })
  it('reads a table, giving every row the header\'s columns', () => {
    assert.deepEqual(shape(parseMarkdown('| | Before | After |\n| --- | --- | --- |\n| Stalls | 126 | **8** |\n| Short |\n\nafter')), [
      ['table', ['', 'Before', 'After'], [['Stalls', '126', '<b>8</b>'], ['Short', '', '']]], ['p', 'after'],
    ])
  })
  it('renders a document with raw HTML as text all the way down, and ends an unclosed fence at the end', () => {
    const blocks = parseMarkdown('<div onclick="x()">hi</div>\n\n- <iframe src="https://evil.example"></iframe>\n\n```\nopen')
    assert.deepEqual(shape(blocks), [['p', '<div onclick="x()">hi</div>'], ['ul', [[['p', '<iframe src="https://evil.example"></iframe>']]]], ['code', null, 'open']])
  })
  it('reads an empty document as nothing', () => {
    assert.deepEqual(parseMarkdown('\n  \n'), [])
  })
})
