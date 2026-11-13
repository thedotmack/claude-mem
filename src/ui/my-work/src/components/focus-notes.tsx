// The owner's own notes on a focus: why it matters. Plain text until Edit; saved like any other focus change, so the
// saved note with Undo covers it. An area with no notes shows one quiet button and nothing else.
import { useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import type { FocusArea } from '@/data'
import type { FocusChanges } from './focus-changes'

/** The worker's bound (WorkViewRoutes focusBody). */
const MAX_FOCUS_NOTES_CHARS = 2000

export function FocusNotes({ area, changes, className }: { area: FocusArea; changes: FocusChanges; className?: string }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<string | null>(null)
  const notes = area.notes ?? ''
  const save = async () => { if (draft !== null && await changes.apply({ action: 'edit-notes', focusAreaId: area.id, notes: draft.trim() })) setDraft(null) }
  return (
    <Req ids={['R19.15']}>
      {draft !== null ? (
        <div className={cn('max-w-2xl space-y-2', className)}>
          <Textarea autoFocus value={draft} maxLength={MAX_FOCUS_NOTES_CHARS} aria-label={t('Why this matters')} onChange={(event) => setDraft(event.target.value)} />
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-11 md:h-7" disabled={changes.saving || draft.trim() === notes} onClick={() => void save()}>{changes.saving ? t('Saving…') : t('Save')}</Button>
            <Button variant="ghost" size="sm" className="h-11 md:h-7" onClick={() => setDraft(null)}>{t('Cancel')}</Button>
          </div>
        </div>
      ) : notes ? (
        <div className={cn('flex max-w-2xl items-start gap-2', className)}>
          <p className="min-w-0 text-sm leading-snug whitespace-pre-wrap text-foreground/85">{notes}</p>
          <Button variant="ghost" size="sm" className="-my-1 h-11 shrink-0 px-2 text-xs text-muted-foreground md:h-7" onClick={() => setDraft(notes)}>{t('Edit')}</Button>
        </div>
      ) : (
        <Button variant="ghost" size="sm" className={cn('-ml-2 h-11 px-2 text-xs text-muted-foreground md:h-7', className)} onClick={() => setDraft('')}>{t('Add why this matters')}</Button>
      )}
    </Req>
  )
}
