// A stage's Markdown as a small tree the page renders with its own elements. The text is written by an agent, so
// nothing in it is ever handed to the browser as HTML: raw tags stay text, and a link or image address is kept only
// when it passes the rules below. Covers what the stage formats ask for: headings, paragraphs, lists, tables, fenced
// code, quotes, rules, links, images, bold, italic and inline code. Anything else reads as plain text.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'image'; src: string; alt: string }

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { kind: 'rule' }

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * A link's address as the reader may follow it: http or https, or a path on the page's own origin. Anything else
 * (`javascript:`, `data:`, `file:`, a `//host` address, a backslash a browser would read as a slash) is null.
 */
export function safeLinkHref(href: string): string | null {
  const url = href.trim()
  if (!url || /[\u0000-\u001f\\]/.test(url)) return null
  if (/^https?:\/\//i.test(url)) return url
  return SCHEME.test(url) || url.startsWith('//') ? null : url
}

/**
 * An image's address as the reader may load it: only a path on the page's own origin, which is where the worker
 * serves the evidence a stage shows. An image from another site would tell that site the stage was opened, so it is
 * not loaded (the reader shows it as a link instead); `data:` and every other scheme are refused too.
 */
export function safeImageSrc(src: string): string | null {
  const url = safeLinkHref(src)
  return url === null || /^https?:\/\//i.test(url) ? null : url
}

const text = (value: string): Inline => ({ kind: 'text', text: value })

/** Joins neighbouring text and drops empty runs, so the tree says only what is shown. */
function tidy(inlines: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const inline of inlines) {
    const last = out.at(-1)
    if (inline.kind === 'text' && !inline.text) continue
    if (inline.kind === 'text' && last?.kind === 'text') last.text += inline.text
    else out.push(inline)
  }
  return out
}

/** The index of the bracket that closes the one at `open`, counting nested pairs; -1 when it never closes. */
function closing(source: string, open: number, left: string, right: string): number {
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === '\\') { index++; continue }
    if (source[index] === left) depth++
    else if (source[index] === right && --depth === 0) return index
  }
  return -1
}

/** `[label](address "title")` starting at `open`: the label, the address and where it ends. */
function bracketed(source: string, open: number): { label: string; address: string; end: number } | null {
  const close = closing(source, open, '[', ']')
  if (close < 0 || source[close + 1] !== '(') return null
  const end = closing(source, close + 1, '(', ')')
  if (end < 0) return null
  const address = source.slice(close + 2, end).trim().replace(/\s+["'][^"']*["']$/, '').replace(/^<(.*)>$/, '$1')
  return { label: source.slice(open + 1, close), address, end }
}

export function parseInline(source: string): Inline[] {
  const out: Inline[] = []
  let plain = ''
  const flush = () => { out.push(text(plain)); plain = '' }
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (char === '\\' && index + 1 < source.length && /[\\`*_{}[\]()#+\-.!|<>~]/.test(source[index + 1])) { plain += source[++index]; continue }
    if (char === '`') {
      const ticks = /^`+/.exec(source.slice(index))![0]
      const end = source.indexOf(ticks, index + ticks.length)
      if (end > 0) { flush(); out.push({ kind: 'code', text: source.slice(index + ticks.length, end).trim() }); index = end + ticks.length - 1; continue }
    }
    if (char === '!' && source[index + 1] === '[') {
      const image = bracketed(source, index + 1)
      if (image) {
        flush()
        const src = safeImageSrc(image.address)
        const href = safeLinkHref(image.address)
        // An image the reader will not load is still named, and linked when its address is one a person may open.
        out.push(src !== null ? { kind: 'image', src, alt: image.label } : href !== null ? { kind: 'link', href, children: [text(image.label || href)] } : text(image.label))
        index = image.end
        continue
      }
    }
    if (char === '[') {
      const link = bracketed(source, index)
      if (link) {
        flush()
        const href = safeLinkHref(link.address)
        const children = parseInline(link.label)
        if (href !== null) out.push({ kind: 'link', href, children })
        else out.push(...children)
        index = link.end
        continue
      }
    }
    if (char === '<') {
      const auto = /^<(https?:\/\/[^\s<>]+)>/i.exec(source.slice(index))
      if (auto) { flush(); out.push({ kind: 'link', href: auto[1], children: [text(auto[1])] }); index += auto[0].length - 1; continue }
    }
    if (char === '*' || char === '_') {
      const marker = source.startsWith(char.repeat(2), index) ? char.repeat(2) : char
      const end = source.indexOf(marker, index + marker.length)
      const inner = end > 0 ? source.slice(index + marker.length, end) : ''
      // An underscore inside a word (snake_case) is a letter, not emphasis.
      const insideWord = char === '_' && (/\w/.test(source[index - 1] ?? '') || /\w/.test(source[end + marker.length] ?? ''))
      if (inner.trim() && inner === inner.trim() && !insideWord) {
        flush()
        out.push({ kind: marker.length === 2 ? 'strong' : 'em', children: parseInline(inner) })
        index = end + marker.length - 1
        continue
      }
    }
    plain += char
  }
  flush()
  return tidy(out)
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])\s+(.*)$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

const cells = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'))
const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || ITEM.test(line) || QUOTE.test(line)

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) { index++; continue }
    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      index++
      while (index < lines.length && !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[index])) body.push(lines[index++])
      index++
      blocks.push({ kind: 'code', language: fence[2] || null, text: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) { blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline(heading[2]) }); index++; continue }
    if (RULE.test(line)) { blocks.push({ kind: 'rule' }); index++; continue }
    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && QUOTE.test(lines[index])) quoted.push(QUOTE.exec(lines[index++])![1])
      blocks.push({ kind: 'quote', children: parseMarkdown(quoted.join('\n')) })
      continue
    }
    const first = ITEM.exec(line)
    if (first) {
      const ordered = /\d/.test(first[2])
      const items: Block[][] = []
      while (index < lines.length) {
        const item = ITEM.exec(lines[index])
        if (!item || /\d/.test(item[2]) !== ordered) break
        // What an item holds: its own line, then every following line indented under it (a nested list, more text).
        const indent = item[1].length + item[2].length + 1
        const body = [item[3]]
        index++
        while (index < lines.length) {
          const next = lines[index]
          if (!next.trim()) {
            const after = lines.slice(index + 1).find((entry) => entry.trim())
            if (after === undefined || !after.startsWith(' '.repeat(indent))) break
            body.push('')
          } else if (next.startsWith(' '.repeat(indent)) || next.startsWith('\t')) body.push(next.startsWith('\t') ? next.slice(1) : next.slice(indent))
          else if (startsBlock(next)) break
          else body.push(next.trim())
          index++
        }
        items.push(parseMarkdown(body.join('\n')))
        while (index < lines.length && !lines[index].trim() && ITEM.test(lines[index + 1] ?? '')) index++
      }
      blocks.push({ kind: 'list', ordered, start: ordered ? Number.parseInt(first[2], 10) : 1, items })
      continue
    }
    if (line.includes('|') && TABLE_DIVIDER.test(lines[index + 1] ?? '') && cells(lines[index + 1]).length === cells(line).length) {
      const head = cells(line).map(parseInline)
      const rows: Inline[][][] = []
      index += 2
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const row = cells(lines[index++]).map(parseInline)
        // A short row is padded and a long one cut, so every row has the header's columns.
        rows.push(head.map((_cell, column) => row[column] ?? []))
      }
      blocks.push({ kind: 'table', head, rows })
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim() && !(paragraph.length && startsBlock(lines[index]))) paragraph.push(lines[index++].trim())
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) })
  }
  return blocks
}
