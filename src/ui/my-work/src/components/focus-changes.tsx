// Saving My Focus changes from the screen: one change at a time (a second click while one is saving does nothing),
// the last change shown with Undo (copied from My Rules' saved note), and the Rename / Edit goal / Merge dialog.
// Undo writes the change that puts things back, where the worker allows one: restore-suggestion for an area that was a
// suggestion (and the only way to undo a merge), keep / done / dismiss for a decided area, the old name or goal.
import { useEffect, useId, useState } from 'react'
import { CheckIcon, RefreshCwIcon, TriangleAlertIcon, Undo2Icon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FieldCount, FieldHelperText, Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Req } from '@/spec/req'
import { FailureDetails } from '@/components/bits'
import { type FocusArea, type FocusChange } from '@/data'
import { useStore, useWorkModel } from '@/store'
import { isPlaceableFocusArea } from '@/live/to-focus-model'
import { describeFocusChange, renderFocusChange } from './focus-change-message'
import { navWordIn } from '../../../../services/work-view/nav-words.mjs'

/** The worker's body bounds (WorkViewRoutes focusBody): a name is a nav label, a goal one sentence. */
const MAX_AREA_NAME_CHARS = 80
const MAX_AREA_GOAL_CHARS = 300

export type FocusChanges = ReturnType<typeof useFocusChanges>

/**
 * My Focus saves from one screen, `place` (an area's page, one request's drawer, Suggested areas), with each change
 * described for the saved note while the screen still shows it. A save that fails is the store's one failed save
 * (store-types.ts FailedFocusSave), kept with the screen that made it: only that screen shows it, its row naming the
 * change, and its Try again makes that save once more on a press (one press, one save; nothing tries again by itself).
 * A failure made on another screen (another area's page, a dialog) is never offered here, and leaving the screen forgets
 * its own.
 */
export function useFocusChanges(place: string) {
  const { focusAreas, requests } = useWorkModel()
  const { history, saving, failed } = useStore.use.focus()
  const { applyFocusChange, undoLastFocusChange, forgetFailedFocusSave } = useStore.getState()
  const failure = failed?.place === place ? failed : null
  useEffect(() => () => forgetFailedFocusSave(place), [place, forgetFailedFocusSave])
  /**
   * `record: false` when the screen shows its own Undo for it (a decided suggestion card); `madeIn`: the place of a part
   * of this screen that shows its own failure (an edit dialog). Resolves true when saved.
   */
  const apply = (change: FocusChange, { record = true, madeIn = place }: { record?: boolean; madeIn?: string } = {}) => {
    const words = describeFocusChange(change, focusAreas, requests)
    return applyFocusChange(change, record ? words : null, { words, place: madeIn })
  }
  const undoLast = () => undoLastFocusChange(place)
  // The very save the failed row names: its change (or the Undo of the change it names), from this screen.
  const attempt = failure?.attempt
  const retry = !attempt ? null : attempt.kind === 'undo' ? undoLast : () => apply(attempt.change, { record: attempt.record !== null })
  return { last: history.at(-1) ?? null, apply, undoLast, retry, failure, saving }
}

/**
 * The last change on one row (c-focus-changes M3): what changed and where it was saved on the left, an outlined Undo on
 * the right (it was three stacked lines of small text with a text Undo under them). A change this screen made that was
 * not saved has the matching row: which change, in the saved note's own words ("Not saved: Marked “Viewer” done."), why
 * folded under Details (local-source's sentence around the worker's answer, or the browser's error: English, never the
 * visible text; G17, fix round R1), and Try again, which makes that same save once more.
 */
export function FocusChangeBar({ changes }: { changes: FocusChanges }) {
  const { t } = useI18n()
  const { sourceKind } = useWorkModel()
  const { last, failure, saving, undoLast, retry } = changes
  return (
    <>
      {failure && (
        <div role="alert" data-change-bar="failed" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-attention-border bg-card px-4 py-2.5 shadow-panel">
          <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-attention-foreground" />
          <div className="min-w-0 flex-1 basis-56 text-sm">
            <p>{failure.attempt.kind === 'undo'
              ? interpolate(t('Undo not saved: {change}.'), { change: renderFocusChange(failure.words, t) })
              : interpolate(t('Not saved: {change}.'), { change: renderFocusChange(failure.words, t) })}</p>
            <FailureDetails cause={failure.reason} />
          </div>
          {retry && <Button variant="outline" size="sm" className="shrink-0" busy={saving} busyLabel={t('Saving…')} onClick={() => void retry()}><RefreshCwIcon />{t('Try again')}</Button>}
        </div>
      )}
      {last && (
        <Req ids={['R16.2', 'R13.7']}>
          <div role="status" data-change-bar="saved" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-shipped-border bg-card px-4 py-2.5 shadow-panel">
            <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-shipped-foreground" />
            <div className="min-w-0 flex-1 basis-56">
              <p className="text-sm font-medium">{renderFocusChange(last, t)}.</p>
              <p className="text-xs text-muted-foreground">{sourceKind === 'sample' ? t('Wireframe: kept on this page only, not actually written.') : sourceKind === 'cloud' ? t('Saved in your cloud viewer; it syncs to your computers. A refresh never overrides it.') : t('Saved on this computer; it syncs to your other machines. A refresh never overrides it.')}</p>
            </div>
            {last.undo
              ? <Button variant="outline" size="sm" className="shrink-0" busy={saving} busyLabel={t('Saving…')} onClick={() => void undoLast()}><Undo2Icon />{t('Undo')}</Button>
              : <span className="text-xs text-muted-foreground">{t('This one can’t be undone from here.')}</span>}
          </div>
        </Req>
      )}
    </>
  )
}

export type AreaEdit = { kind: 'rename' | 'edit-goal' | 'merge'; area: FocusArea }

/**
 * Rename, edit the goal, or choose the area to merge into (c-focus-changes). One dialog; the worker refuses what it
 * cannot save. Save says what it saves ("Save name") beside Cancel (D b8 M 170); a name or goal has a helper line and its
 * count against the worker's limit; Save waits, with a line saying for what, until there is something to save (Merge:
 * until an area is chosen; G16). A save that fails says so in plain words, the reason under Details (G17), and the
 * dialog stays open to save again or cancel. Closing with changed words asks first (D b8 M 173). `ownUndo` says which
 * changes the screen shows its own Undo for; every other change goes to the shared change bar.
 */
export function AreaEditDialog({ edit, changes, onClose, onSaved, ownUndo }: {
  edit: AreaEdit | null; changes: FocusChanges; onClose: () => void; onSaved?: (change: FocusChange) => void; ownUndo?: (change: FocusChange) => boolean
}) {
  const { t } = useI18n()
  const { focusAreas } = useWorkModel()
  const [text, setText] = useState('')
  const [into, setInto] = useState('')
  const [openedFor, setOpenedFor] = useState<AreaEdit | null>(null)
  const fieldId = useId()
  const helperId = useId()
  const waitsId = useId()
  // The dialog's own place for its saves (useFocusChanges' madeIn): a failure its Save made is its own to show, the page's
  // change bar never offers it, and it goes with the dialog, cancelled, saved or gone, so nothing is left to Try again.
  const dialogPlace = useId()
  const failed = useStore((state) => state.focus.failed)
  const ownFailure = failed?.place === dialogPlace ? failed : null
  useEffect(() => () => useStore.getState().forgetFailedFocusSave(dialogPlace), [dialogPlace])
  const close = () => { useStore.getState().forgetFailedFocusSave(dialogPlace); onClose() }
  if (edit !== openedFor) {
    setOpenedFor(edit)
    setText(edit?.kind === 'rename' ? edit.area.name : edit?.kind === 'edit-goal' ? edit.area.goal ?? '' : '')
    setInto('')
  }
  if (!edit) return null
  const original = edit.kind === 'rename' ? edit.area.name : edit.kind === 'edit-goal' ? edit.area.goal ?? '' : ''
  const limit = edit.kind === 'rename' ? MAX_AREA_NAME_CHARS : MAX_AREA_GOAL_CHARS
  const targets = focusAreas.filter((area) => isPlaceableFocusArea(area) && area.id !== edit.area.id)
  const navWord = edit.kind === 'rename' ? navWordIn(text) : null
  const change: FocusChange = edit.kind === 'merge' ? { action: 'merge', focusAreaId: edit.area.id, intoFocusAreaId: into }
    : edit.kind === 'rename' ? { action: 'rename', focusAreaId: edit.area.id, name: text } : { action: 'edit-goal', focusAreaId: edit.area.id, goal: text }
  // What Save waits for, said on screen beside it (G16); null when there is something to save.
  const waitsFor = edit.kind === 'merge' ? (into ? null : t('Save waits until you choose the area to merge into.'))
    : !text.trim() ? (edit.kind === 'rename' ? t('Save waits for a name.') : t('Save waits for a goal.'))
      : navWord ? t('Save waits for a name that is not a page name.') : null
  const submit = async () => {
    if (waitsFor !== null || changes.saving) return
    if (await changes.apply(change, { record: !ownUndo?.(change), madeIn: dialogPlace })) { onSaved?.(change); close() }
  }
  const title = edit.kind === 'rename' ? interpolate(t('Rename “{name}”'), { name: edit.area.name })
    : edit.kind === 'edit-goal' ? interpolate(t('Goal for “{name}”'), { name: edit.area.name })
    : interpolate(t('Merge “{name}” into…'), { name: edit.area.name })
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent hasUnsavedText={edit.kind !== 'merge' && text !== original}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {edit.kind === 'rename' ? t('A short name you would ask for things inside of. It can’t reuse a page name.')
              : edit.kind === 'edit-goal' ? t('One sentence saying what this area is for.')
                : interpolate(t('Its requests and asks show under the area you choose. Undo right after brings “{name}” back as it was.'), { name: edit.area.name })}
          </DialogDescription>
        </DialogHeader>
        {edit.kind === 'merge' ? (
          <div className="space-y-2">
            <Label htmlFor={fieldId}>{t('Merge into')}</Label>
            <Select value={into} onValueChange={setInto}>
              <SelectTrigger id={fieldId} className="w-full"><SelectValue placeholder={t('Choose an area')} /></SelectTrigger>
              <SelectContent>{targets.map((area) => <SelectItem key={area.id} value={area.id}>{area.name}{area.status === 'suggested' ? t(' · suggested') : ''}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor={fieldId}>{edit.kind === 'rename' ? t('Name') : t('Goal')}</Label>
            <Input id={fieldId} value={text} maxLength={limit} aria-describedby={helperId} onChange={(event) => setText(event.target.value)}
              // Enter saves, except the Enter that picks a word while an input method composes it (Chinese, Korean), as
              // the reply box's does (conversation-continue.tsx).
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} />
            {/* The limit is the worker's (WorkViewRoutes focusBody), so the count is real, not a guess (c-focus-changes M2). */}
            <div className="flex items-start justify-between gap-3">
              <FieldHelperText id={helperId}>{edit.kind === 'rename' ? t('Shown in Focus areas and on every request in this area.') : t('Shown under the area’s name on its page.')}</FieldHelperText>
              <FieldCount count={text.length} limit={limit} className="shrink-0" />
            </div>
            {navWord && <p className="text-xs text-attention-foreground">{interpolate(t('“{text}” reuses the page name “{navWord}”. Pick a name that means only this area.'), { text: text.trim(), navWord })}</p>}
          </div>
        )}
        {ownFailure && (
          <div role="alert" data-dialog-save-failure="" className="space-y-1 text-sm">
            <p className="text-destructive">{t('This change was not saved.')}</p>
            <FailureDetails cause={ownFailure.reason} />
          </div>
        )}
        {waitsFor && <p id={waitsId} data-save-waits="" className="text-xs text-muted-foreground">{waitsFor}</p>}
        <DialogFooter showCloseButton>
          <Button aria-disabled={waitsFor !== null || undefined} aria-describedby={waitsFor ? waitsId : undefined} busy={changes.saving} busyLabel={t('Saving…')} onClick={() => void submit()}>
            {edit.kind === 'rename' ? t('Save name') : edit.kind === 'edit-goal' ? t('Save goal') : t('Merge')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
