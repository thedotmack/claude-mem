import { Fragment, memo, type ReactNode } from 'react'
import { marked, type Token, type Tokens } from 'marked'

// All text goes through React's escaping. Links and images are displayed without
// href/src attributes; painting a passage must never navigate or load remote data.
function content(tokens: Token[] = []): ReactNode {
  return tokens.map((token, i) => <Fragment key={i}>{render(token)}</Fragment>)
}

function render(token: Token): ReactNode {
  switch (token.type) {
    case 'space': return null
    case 'br': return <br />
    case 'hr': return <hr className="border-border" />
    case 'strong': return <strong>{content(token.tokens)}</strong>
    case 'em': return <em>{content(token.tokens)}</em>
    case 'del': return <del>{content(token.tokens)}</del>
    case 'codespan': return <code className="rounded bg-muted px-1 text-[0.88em]">{token.text}</code>
    case 'code': return <pre className="overflow-x-auto rounded-md border bg-muted/70 p-3 font-mono text-xs">{token.text}</pre>
    case 'link': return <span className="text-accent-foreground underline decoration-dotted">{content(token.tokens)}</span>
    case 'image': return <span className="text-muted-foreground">[{token.text || 'Image'}]</span>
    case 'html': return token.raw
    case 'text': return token.tokens ? content(token.tokens) : token.text
    case 'paragraph': return <p>{content(token.tokens)}</p>
    case 'heading': return <p className={token.depth < 3 ? 'text-lg font-semibold tracking-tight' : 'font-semibold'}>{content(token.tokens)}</p>
    case 'blockquote': return <blockquote className="border-l-2 border-accent-border pl-3 text-muted-foreground">{content(token.tokens)}</blockquote>
    case 'list': {
      const list = token as Tokens.List
      const items = list.items.map((item, i) => <li key={i}>{content(item.tokens)}</li>)
      return list.ordered ? <ol start={list.start || 1} className="list-decimal pl-5">{items}</ol>
        : <ul className="list-disc pl-5">{items}</ul>
    }
    case 'checkbox': return token.checked ? '☑ ' : '☐ '
    case 'table': {
      const table = token as Tokens.Table
      return <div className="overflow-x-auto"><table className="min-w-full border-collapse text-left text-xs">
        <thead><tr>{table.header.map((cell, i) => <th key={i} className="border-b p-1.5">{content(cell.tokens)}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className="border-b p-1.5">{content(cell.tokens)}</td>)}</tr>)}</tbody>
      </table></div>
    }
    default: return token.raw
  }
}

export const PaintMarkdown = memo(function PaintMarkdown({ markdown }: { markdown: string }) {
  return <div className="pointer-events-none break-words text-sm leading-relaxed">{content(marked.lexer(markdown))}</div>
})
