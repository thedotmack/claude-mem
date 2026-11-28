// The one failure line (design pass Phase 4; Codex D14, Claude D13): when the last review of goals and progress
// failed, one quiet line under the page's title says when, how old the review on screen is, and "Review details",
// which opens Machine and sync, where the review's state, its cause and "Try review again" live. It replaced the
// refresh banner that sat in the middle of six pages. Nothing shows while the review is fine.
import { useState } from 'react'
import { ChevronRightIcon, CircleAlertIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { placeLinkPress, usePageHref } from '@/lib/place-link'
import { sentenceWith } from '@/lib/sentence-with'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'
import { refreshLineState, refreshRecordKey } from '@/live/refresh-line'
import { useStore, useWorkModel } from '@/store'
import { RecordedTime } from './bits'

export function ReviewFailedLine({ className }: { className?: string }) {
  const { t } = useI18n()
  const { refresh, lastRuns } = useWorkModel()
  const href = usePageHref('machine')
  // The failure already on screen when the line was first drawn is read as the page's text. A review that fails while
  // the page is open is news, so its line is an alert, which is read out as it appears (a status region inserted
  // already filled is often skipped).
  const [failureWhenDrawn] = useState(() => refreshLineState(refresh) === 'failed' ? refreshRecordKey(refresh) : null)
  if (refreshLineState(refresh) !== 'failed') return null
  const newFailure = refreshRecordKey(refresh) !== failureWhenDrawn
  const failedAt = refresh?.finishedAt ? <RecordedTime iso={refresh.finishedAtIso} words={refresh.finishedAt} /> : null
  const reviewed = lastRuns.progress
  return (
    <p role={newFailure ? 'alert' : 'status'} data-review-failed-line="" className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-attention-foreground', className)}>
      <span className="flex min-w-0 items-start gap-2">
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0">
          {failedAt ? sentenceWith(t('Review failed at {time}.'), 'time', failedAt) : t('The last review failed.')}
          {reviewed && <> {sentenceWith(t('Last reviewed at {time}.'), 'time', <RecordedTime iso={reviewed.lastRunAtIso} words={reviewed.lastRunAt} />)}</>}
        </span>
      </span>
      <a href={href} onClick={placeLinkPress(() => useStore.getState().goToPage('machine'))}
        className={cn(buttonVariants({ variant: 'link', size: 'sm' }), 'h-auto gap-1 px-0 font-medium text-attention-foreground')}>
        {t('Review details')}<ChevronRightIcon aria-hidden="true" />
      </a>
    </p>
  )
}
