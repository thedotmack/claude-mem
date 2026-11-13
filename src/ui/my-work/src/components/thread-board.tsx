// The board: the requests Cards and List show, in one column per state. Nothing drags, because no write would
// mean a drop; a card opens its request.
import { useI18n } from '@/lib/i18n'
import { Req } from '@/spec/req'
import type { Request } from '@/data'
import { boardColumns, type BoardColumn } from '@/live/board-columns'
import { RequestCard } from './request-card'

const COLUMN_LABEL: Record<BoardColumn, string> = { 'your-move': 'Your move', review: 'Review', working: 'Working', idle: 'Idle', shipped: 'Shipped' }

export function ThreadBoard({ requests, onOpen, onOpenFocus }: { requests: Request[]; onOpen: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void }) {
  const { t } = useI18n()
  return (
    <Req ids={['R4.7', 'R11.1']}>
      {/* Phones stack the columns. Wider screens keep them side by side and scroll inside this row, never the page. */}
      <div className="flex min-w-0 flex-col gap-6 md:-mx-1 md:flex-row md:items-start md:gap-4 md:overflow-x-auto md:px-1 md:pt-1 md:pb-2">
        {boardColumns(requests).map(({ column, requests: inColumn }) => (
          <section key={column} aria-label={t(COLUMN_LABEL[column])} className="flex min-w-0 flex-col gap-3 md:min-w-72 md:flex-1 md:basis-0">
            <h2 className="flex items-baseline gap-2 text-sm font-semibold tracking-tight">{t(COLUMN_LABEL[column])}<span className="font-normal text-muted-foreground tabular-nums">{inColumn.length}</span></h2>
            {inColumn.length === 0 ? <p className="text-sm text-muted-foreground">{t('Nothing here')}</p> : (
              <ul className="space-y-4">
                {inColumn.map((request) => <li key={request.id}><RequestCard request={request} onOpen={() => onOpen(request)} onOpenFocus={onOpenFocus} /></li>)}
              </ul>
            )}
          </section>
        ))}
      </div>
    </Req>
  )
}
