// Search over the requests the page already holds (components/thread-search.tsx): which threads a typed query finds,
// in what order, and what picking one does. Pure, so a keystroke costs no request and the rules are tested without a page.
import { isDone, type FocusArea, type Request } from '../data.ts'
import { chatLinks, requestChat } from './chat-links.ts'
import { sortThreads } from './thread-groups.ts'
import { resolveFocusAreaId } from './to-focus-model.ts'
import { NEXT_STEP_NOT_RECORDED, NO_WORK_YET } from './to-work-model.ts'

/** With nothing typed: the few threads most likely wanted, what waits on the owner first. */
export const SUGGESTED_THREADS = 8
/** A typed query: enough to scan, never the whole board. */
export const MAX_THREAD_HITS = 50

export interface ThreadHit {
  request: Request
  /** The title a row shows; null while the title is still being written. */
  title: string | null
  /** Its focus area's name. Null in Other or while it is not sorted yet. */
  focusName: string | null
  /** The recorded next step or open question. Null when none is recorded. */
  next: string | null
}

/** The words a query asks for: lower case, split on spaces. Every one must be found. */
export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** A thread as a row shows it, and the text beyond its title that a query may match, lower case. */
function readThread(request: Request, areas: readonly FocusArea[]): { hit: ThreadHit; rest: string } {
  const areaId = resolveFocusAreaId(request.focusAreaId, areas)
  const area = areas.find((candidate) => candidate.id === areaId)
  const nextText = request.question?.text ?? request.next.text
  const next = nextText && nextText !== NEXT_STEP_NOT_RECORDED && nextText !== NO_WORK_YET ? nextText : null
  const rest = [next, request.why, area?.name, area?.initiative].filter(Boolean).join('\n').toLowerCase()
  return { hit: { request, title: request.title ?? request.resolvesTo?.title ?? null, focusName: area?.name ?? null, next }, rest }
}

/**
 * The threads a query finds. Every word must appear in the title, next step, why, focus name or the focus's initiative,
 * in any order and any case. Threads whose title holds every word come first; within each group, what waits on a
 * person, then what is moving, then the rest, newest first (the board's own order). Nothing typed lists the open
 * threads in that order; a thread that rests in Done (shipped, checked, closed) is found only by typing.
 */
export function searchThreads(requests: readonly Request[], areas: readonly FocusArea[], query: string): ThreadHit[] {
  const words = queryWords(query)
  if (words.length === 0) return sortThreads(requests.filter((request) => !isDone(request))).slice(0, SUGGESTED_THREADS).map((request) => readThread(request, areas).hit)
  const inTitle: ThreadHit[] = []
  const elsewhere: ThreadHit[] = []
  for (const request of sortThreads(requests)) {
    const { hit, rest } = readThread(request, areas)
    const title = hit.title?.toLowerCase() ?? ''
    if (words.every((word) => title.includes(word))) inTitle.push(hit)
    else if (words.every((word) => title.includes(word) || rest.includes(word))) elsewhere.push(hit)
  }
  return [...inTitle, ...elsewhere].slice(0, MAX_THREAD_HITS)
}

/** A title cut into the parts a query matched and the parts between, in order, so a row can mark the matches. */
export function markMatches(text: string, words: readonly string[]): { text: string; match: boolean }[] {
  const lower = text.toLowerCase()
  // A letter whose lower case has another length would move every later mark; such a title is shown unmarked.
  if (lower.length !== text.length || words.length === 0) return [{ text, match: false }]
  const marked = new Array<boolean>(text.length).fill(false)
  for (const word of words) {
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + word.length)) marked.fill(true, at, at + word.length)
  }
  const parts: { text: string; match: boolean }[] = []
  for (let index = 0; index < text.length; index += 1) {
    const last = parts[parts.length - 1]
    if (last && last.match === marked[index]) last.text += text[index]
    else parts.push({ text: text[index], match: marked[index] })
  }
  return parts
}

/** Where a found thread's chat opens: in the tool's app or as the recorded transcript. `board` when it has no chat link, so the board is all it can show. */
export type ThreadOpen = { kind: 'chat'; href: string; tool: string } | { kind: 'board' }

export function threadOpen(request: Pick<Request, 'id' | 'chat'>): ThreadOpen {
  const chat = requestChat(request)
  if (!chat) return { kind: 'board' }
  const links = chatLinks(chat)
  const href = links.openHref ?? links.transcriptHref
  return href === undefined ? { kind: 'board' } : { kind: 'chat', href, tool: links.tool }
}

export type ShortcutPlatform = 'mac' | 'other'
/** The part of a key event the shortcuts read; a DOM or React keyboard event fits it. */
export interface KeyPress { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

/** Cmd+K on a Mac, Ctrl+K elsewhere, with no other modifier. On a Mac, Ctrl+K stays the text field's own key. */
export function isSearchShortcut(event: KeyPress, platform: ShortcutPlatform): boolean {
  if (event.key.toLowerCase() !== 'k' || event.altKey || event.shiftKey) return false
  return platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

/** What picking a found thread does. */
export type ThreadPick = 'board' | 'chat'

/**
 * Which Enter was pressed on a result. Plain Enter shows the thread on the board; with Cmd or Ctrl it opens the chat,
 * and a thread with no chat link is shown on the board either way. Null for any other key.
 */
export function enterPick(event: KeyPress, target: ThreadOpen): ThreadPick | null {
  if (event.key !== 'Enter') return null
  return (event.metaKey || event.ctrlKey) && target.kind === 'chat' ? 'chat' : 'board'
}
