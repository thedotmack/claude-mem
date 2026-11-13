// The board: one focus's threads in columns, by what a person must do next. Nothing drags, because no
// write would mean a drop; a card opens its request or its chat.
import { useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import type { Request } from '@/data'
import { useFreshlyUpdated, useStore } from '@/store'
import { boardColumns, columnFolds, type BoardColumn } from '@/live/board-columns'
import { AskedAge, ChatLinks, RiskDot, useRequestChatLinks } from './thread-list'
import { useNow } from '@/lib/use-now'

/** `newest`: the column grows without end, so it shows that many until asked for the rest. */
const COLUMN: Record<BoardColumn, { label: string; newest?: number }> = {
  answer: { label: 'Answer' },
  review: { label: 'Review' },
  approve: { label: 'Approve' },
  working: { label: 'Working' },
  idle: { label: 'Idle', newest: 5 },
  done: { label: 'Done', newest: 5 },
}

function BoardCard({ request, now, onOpen }: { request: Request; now: number; onOpen: (request: Request) => void }) {
  const { t } = useI18n()
  const fresh = useFreshlyUpdated(request.id)
  const links = useRequestChatLinks(request)
  const next = request.question?.text ?? request.next.text
  return (
    <li className={cn('grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 gap-y-1 rounded-md border bg-card px-2.5 py-2', fresh && 'just-updated')}>
      {/* The column's name is the card's status, so its dot is its risk, as on a thread row. */}
      <RiskDot request={request} />
      <button type="button" onClick={() => onOpen(request)} className={cn('min-w-0 rounded-sm text-left text-sm leading-snug font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring', !request.title && 'text-muted-foreground')}>
        {request.title ?? request.resolvesTo?.title ?? t('New request, title being written')}
      </button>
      <span className="-my-1 -mr-1.5 inline-flex items-center gap-1"><AskedAge request={request} now={now} />{links && <ChatLinks chat={links} showTranscript />}</span>
      {next && <p className="col-span-2 col-start-2 line-clamp-2 text-xs leading-snug text-foreground/85" title={next}>{t(next)}</p>}
    </li>
  )
}

function Column({ column, requests, folded, onOpen }: { column: BoardColumn; requests: Request[]; folded: boolean | null; onOpen: (request: Request) => void }) {
  const { t } = useI18n()
  const [all, setAll] = useState(false)
  const now = useNow()
  const { label, newest } = COLUMN[column]
  const shown = newest === undefined || all ? requests : requests.slice(0, newest)
  const count = <span className="text-xs font-normal text-muted-foreground tabular-nums">{requests.length}</span>
  return (
    <section aria-label={t(label)} className="flex min-w-0 flex-col gap-2 md:max-h-[calc(100svh-13rem)]">
      {folded === null ? <h2 className="flex items-baseline gap-2 px-1 text-sm font-semibold tracking-tight">{t(label)}{count}</h2> : (
        <Req ids={['R19.21']}>
          <h2 className="text-sm font-semibold tracking-tight">
            <button type="button" aria-expanded={!folded} onClick={() => useStore.getState().setDoneColumnOpen(folded)}
              className="-my-3 flex h-11 items-baseline gap-2 rounded-sm px-1 text-left text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring md:my-0 md:h-auto">
              <ChevronRightIcon className={cn('size-3.5 shrink-0 self-center transition-transform motion-reduce:transition-none', !folded && 'rotate-90')} />{t(label)}{count}
            </button>
          </h2>
        </Req>
      )}
      {!folded && (
        <>
          <ul className="min-h-0 space-y-2 md:overflow-y-auto">
            {shown.map((request) => <BoardCard key={request.id} request={request} now={now} onOpen={onOpen} />)}
          </ul>
          {shown.length < requests.length && <Button variant="ghost" size="sm" className="h-11 self-start px-1 text-xs text-muted-foreground md:h-7" onClick={() => setAll(true)}>{interpolate(t('Show all {count}'), { count: requests.length })}</Button>}
        </>
      )}
    </section>
  )
}

/**
 * One focus's threads as columns. `showDone` is the Done filter: the person asked for those threads, so the Done
 * column is open whatever they last left it as.
 */
export function ThreadBoard({ requests, showDone, onOpen }: { requests: Request[]; showDone: boolean; onOpen: (request: Request) => void }) {
  const doneColumnOpen = useStore((state) => state.view.doneColumnOpen)
  const folds = (column: BoardColumn) => columnFolds(column) ? !(showDone || doneColumnOpen) : null
  return (
    <Req ids={['R19.10', 'R11.1']}>
      <div className={cn('grid grid-cols-1 gap-x-3 gap-y-6 md:grid-cols-3', folds('done') ? 'xl:grid-cols-[repeat(5,minmax(0,1fr))_auto]' : 'xl:grid-cols-6')}>
        {boardColumns(requests).map((entry) => <Column key={entry.column} column={entry.column} requests={entry.requests} folded={folds(entry.column)} onOpen={onOpen} />)}
      </div>
    </Req>
  )
}
