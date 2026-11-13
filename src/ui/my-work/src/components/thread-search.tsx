// Search every thread from anywhere (Cmd+K, Ctrl+K off a Mac, or the header button): Enter shows it on the board,
// Cmd or Ctrl with Enter opens its chat. The matching, the order and the keys are live/thread-search.ts; this is the dialog around them.
import { ageSentence, requestAge } from '@/live/request-age'
import { useNow } from '@/lib/use-now'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { MessageSquareIcon, SearchIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Button, buttonVariants } from '@/components/ui/button'
import { DialogOverlay, DialogPortal } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { isSampleHref, type FocusArea, type Request } from '@/data'
import { enterPick, isSearchShortcut, markMatches, queryWords, searchThreads, threadOpen, type ShortcutPlatform, type ThreadHit, type ThreadOpen } from '@/live/thread-search'
import { STATE_DOT } from './bits'
import { statusLabel } from '@/live/status-label'

const PLATFORM: ShortcutPlatform = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other'
const KEYS: Record<ShortcutPlatform, { open: string; chat: string; aria: string }> = {
  mac: { open: '⌘K', chat: '⌘↵', aria: 'Meta+K' },
  other: { open: 'Ctrl K', chat: 'Ctrl ↵', aria: 'Control+K' },
}
const KEY = 'rounded border border-border bg-muted/60 px-1 font-sans text-[0.7rem] leading-4 text-muted-foreground'

/**
 * One found thread. The row shows it on the board. The control at its end is the chat's own link, so a click, and
 * Cmd or Ctrl with Enter through it, navigate the way the board's chat link does.
 */
function ResultRow({ hit, target, href, words, id, chatId, active, onActive, onChat, onBoard }: {
  hit: ThreadHit; target: ThreadOpen; href: string | undefined; words: readonly string[]; id: string; chatId: string; active: boolean
  onActive: () => void; onChat: (event: React.MouseEvent) => void; onBoard: () => void
}) {
  const { t } = useI18n()
  const { request } = hit
  const quiet = [hit.focusName, hit.next && t(hit.next)].filter(Boolean).join(' · ')
  const age = requestAge(request.startedAtIso, useNow())
  const link = href === undefined ? {} : { href, ...(href.startsWith('/') ? { target: '_blank', rel: 'noreferrer' } : {}) }
  return (
    <li role="presentation" onMouseMove={onActive} className={cn('flex items-center rounded-lg', active && 'bg-accent')}>
      <div
        id={id} role="option" aria-selected={active} onClick={onBoard}
        className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-2 pr-1 pl-3 text-sm outline-none md:min-h-9 md:py-1.5"
      >
        <span title={statusLabel(request, t)} className={cn('size-2 shrink-0 rounded-full', STATE_DOT[request.state])} />
        <span className="sr-only">{statusLabel(request, t)}.</span>
        <span className={cn('min-w-0 truncate font-medium max-sm:flex-1 sm:max-w-[70%] sm:shrink-0', !hit.title && 'text-muted-foreground')}>
          {hit.title ? markMatches(hit.title, words).map((part, index) => part.match
            ? <mark key={index} className="rounded-[3px] bg-attention text-attention-foreground">{part.text}</mark>
            : <span key={index}>{part.text}</span>) : t('New request, title being written')}
        </span>
        <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block">{quiet}</span>
        {age && <span title={interpolate(t(ageSentence(age)), { count: age.count })} className="ml-auto shrink-0 text-xs text-muted-foreground/80 tabular-nums">{age.unit === 'now' ? t('now') : age.short}</span>}
      </div>
      {target.kind === 'chat'
        ? <a id={chatId} tabIndex={-1} {...link} onClick={onChat} aria-label={interpolate(t('Open the chat: {title} ({tool})'), { title: hit.title ?? t('New request, title being written'), tool: target.tool })} title={interpolate(t('Open chat ({keys})'), { keys: KEYS[PLATFORM].chat })}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'mr-1 h-11 min-w-11 shrink-0 cursor-pointer gap-1.5 px-2 text-xs font-normal text-muted-foreground md:h-7 md:min-w-7')}>
            <span className="hidden sm:inline">{target.tool}</span><MessageSquareIcon />
          </a>
        : <span className="mr-1 w-2 shrink-0" />}
    </li>
  )
}

interface SearchProps { requests: readonly Request[]; focusAreas: readonly FocusArea[]; sample: boolean; onShow: (request: Request) => void }

/** The field, the results and the keys. Mounted only while the dialog is open, so each opening starts empty. */
function SearchBody({ requests, focusAreas, sample, onShow, onDone }: SearchProps & { onDone: () => void }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const listId = useId()
  const hits = useMemo(() => searchThreads(requests, focusAreas, query), [requests, focusAreas, query])
  const words = useMemo(() => queryWords(query), [query])
  const active = Math.min(activeIndex, hits.length - 1)
  const optionId = (index: number) => `${listId}-${index}`
  const chatId = (index: number) => `${listId}-${index}-chat`
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active, hits])

  const showOnBoard = (request: Request) => { onDone(); onShow(request) }
  /** A real link navigates by itself. A sample session exists nowhere (as on the board's rows): say so and open nothing. */
  const openChat = (event: React.MouseEvent, href: string | undefined) => {
    if (href !== undefined) return onDone()
    event.preventDefault()
    setNotice(t('Sample link. The real page attaches when the agent records it.'))
  }
  const onInputKey = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (hits.length) setActiveIndex((active + (event.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length)
    } else if (event.key === 'Enter' && hits[active]) {
      event.preventDefault()
      // The chat opens through its own link on the row, as a click on it would.
      if (enterPick(event, threadOpen(hits[active].request)) === 'chat') document.getElementById(chatId(active))?.click()
      else showOnBoard(hits[active].request)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2.5 border-b px-4">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={hits.length ? optionId(active) : undefined}
          aria-label={t('Search threads')} placeholder={t('Search threads…')} autoComplete="off" autoCorrect="off" spellCheck={false}
          value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setNotice(null) }} onKeyDown={onInputKey}
          // 16px on phones, so iOS does not zoom the page when the field takes focus.
          className="h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
        />
      </div>
      <ul ref={list} id={listId} role="listbox" aria-label={t('Threads')} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {hits.map((hit, index) => {
          const target = threadOpen(hit.request)
          const href = target.kind === 'chat' && !sample && !isSampleHref(target.href) ? target.href : undefined
          return <ResultRow key={hit.request.id} hit={hit} target={target} href={href} words={words} id={optionId(index)} chatId={chatId(index)} active={index === active} onActive={() => setActiveIndex(index)} onChat={(event) => openChat(event, href)} onBoard={() => showOnBoard(hit.request)} />
        })}
      </ul>
      {hits.length === 0 && <p role="status" className="px-4 pb-6 text-center text-sm text-muted-foreground">{query.trim() ? interpolate(t('No thread matches “{query}”'), { query: query.trim() }) : t('No threads yet')}</p>}
      {/* A phone has no such keys: there the line shows only when it has something to say. */}
      <p className={cn('flex-wrap items-center gap-x-3 gap-y-1 border-t bg-surface/70 px-4 py-2 text-xs text-muted-foreground', notice ? 'flex' : 'hidden sm:flex')}>
        {notice ? <span role="status" className="font-medium text-foreground">{notice}</span> : <>
          <span><kbd className={KEY}>↑</kbd> <kbd className={KEY}>↓</kbd> {t('to move')}</span>
          <span><kbd className={KEY}>↵</kbd> {t('to show on the board')}</span>
          <span><kbd className={KEY}>{KEYS[PLATFORM].chat}</kbd> {t('to open the chat')}</span>
          <span><kbd className={KEY}>esc</kbd> {t('to close')}</span>
        </>}
      </p>
    </>
  )
}

/** Opens the search by mouse or touch, and shows the key that does the same. */
export function ThreadSearchButton({ onOpen, className }: { onOpen: () => void; className?: string }) {
  const { t } = useI18n()
  return (
    <Button variant="ghost" size="sm" onClick={onOpen} className={cn('h-11 min-w-11 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground md:h-8 md:min-w-0', className)} aria-label={t('Search threads')} aria-haspopup="dialog" aria-keyshortcuts={KEYS[PLATFORM].aria} title={interpolate(t('Search threads ({keys})'), { keys: KEYS[PLATFORM].open })}>
      <SearchIcon />
      <kbd className={cn(KEY, 'hidden md:inline')}>{KEYS[PLATFORM].open}</kbd>
    </Button>
  )
}

/**
 * Whether the search is open, and the key that opens it from anywhere in the page, a text field included, and closes
 * it again. Closing gives focus back to where the search was started from (the dialog has no trigger of its own to
 * return to), unless a result was opened: then focus belongs to what it opened.
 */
export function useThreadSearch() {
  const [open, setOpen] = useState(false)
  const now = useRef({ open: false, acted: false, startedFrom: null as Element | null })
  const change = useCallback((next: boolean) => {
    if (next && !now.current.open) now.current = { open: true, acted: false, startedFrom: document.activeElement }
    now.current.open = next
    setOpen(next)
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event, PLATFORM)) return
      event.preventDefault()
      change(!now.current.open)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [change])
  return useMemo(() => ({
    open,
    change,
    show: () => change(true),
    done: () => { now.current.acted = true; change(false) },
    returnFocus: () => { if (!now.current.open && !now.current.acted && now.current.startedFrom instanceof HTMLElement) now.current.startedFrom.focus() },
  }), [open, change])
}

/** The search dialog. `onShow` is the board's own way to open a request. */
export function ThreadSearch({ search, ...props }: SearchProps & { search: ReturnType<typeof useThreadSearch> }) {
  const { t } = useI18n()
  return (
    <Req ids={['R19.20']}>
      <DialogPrimitive.Root open={search.open} onOpenChange={search.change}>
        <DialogPortal>
          <DialogOverlay />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => { event.preventDefault(); search.returnFocus() }}
            className="fixed top-[max(1rem,12vh)] left-1/2 z-50 flex max-h-[min(32rem,calc(100svh-2rem))] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-popover outline-none"
          >
            <DialogPrimitive.Title className="sr-only">{t('Search threads')}</DialogPrimitive.Title>
            <SearchBody {...props} onDone={search.done} />
          </DialogPrimitive.Content>
        </DialogPortal>
      </DialogPrimitive.Root>
    </Req>
  )
}
