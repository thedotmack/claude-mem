// Saving My Focus changes from the screen: one change at a time (a second click while one is saving does nothing),
// the last change shown with Undo (copied from My Rules' saved note), and the Rename / Edit goal / Merge dialog.
// Undo writes the change that puts things back, where the worker allows one: restore-suggestion for an area that was a
// suggestion (and the only way to undo a merge), keep / done / dismiss for a decided area, the old name or goal.
import { useState } from 'react'
import { CheckIcon } from 'lucide-react'
import { interpolate, useI18n } from '../../../i18n'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Req } from '@/spec/req'
import { OTHER_FOCUS_AREA_ID, type FocusArea, type FocusChange, type Request } from '@/data'
import { useStore, useWorkModel, type FocusChangeRecord } from '@/store'
import { focusAreaLabel, isPlaceableFocusArea, resolveFocusAreaId } from '@/live/to-focus-model'
import { navWordIn } from '../../../../services/work-view/nav-words.mjs'

/** The worker's body bounds (WorkViewRoutes focusBody). */
const MAX_AREA_NAME_CHARS = 80
const MAX_AREA_GOAL_CHARS = 300

/** The changes that return an area to the status it had, or null when the worker allows none. */
function backTo(area: FocusArea): FocusChange[] | null {
  if (area.status === 'suggested') return area.source === 'owner' ? null : [{ action: 'restore-suggestion', focusAreaId: area.id }]
  return [{ action: STATUS_ACTION[area.status], focusAreaId: area.id }]
}
const STATUS_ACTION = { kept: 'keep', done: 'done', dismissed: 'dismiss' } as const

/** What one change says in the saved note, and how to undo it, read from the areas as they were before it. */
function describeFocusChange(change: FocusChange, areas: FocusArea[], requests: Request[], t?: (s: string) => string): FocusChangeRecord {
  const tr = t ?? ((s: string) => s)
  const area = areas.find((entry) => entry.id === change.focusAreaId)
  const name = area?.name || tr('the area')
  switch (change.action) {
    case 'keep': return { text: interpolate(tr('Kept “{name}”'), { name }), undo: area ? backTo(area) : null }
    case 'dismiss': return { text: interpolate(tr('Dismissed “{name}”'), { name }), undo: area ? backTo(area) : null }
    case 'done': return { text: interpolate(tr('Marked “{name}” done'), { name }), undo: area ? backTo(area) : null }
    case 'rename': return { text: interpolate(tr('Renamed “{name}” to “{newName}”'), { name, newName: change.name?.trim() ?? '' }), undo: area ? [{ action: 'rename', focusAreaId: area.id, name: area.name }] : null }
    case 'edit-goal': return { text: interpolate(tr('Changed the goal of “{name}”'), { name }), undo: area?.goal ? [{ action: 'edit-goal', focusAreaId: area.id, goal: area.goal }] : null }
    case 'merge': {
      const into = areas.find((entry) => entry.id === change.intoFocusAreaId)?.name ?? tr('another area')
      // Only restore-suggestion clears a merge; a kept or done area is then decided again as it was.
      const undo = area && area.source !== 'owner' ? [{ action: 'restore-suggestion' as const, focusAreaId: area.id }, ...(area.status === 'suggested' ? [] : backTo(area) ?? [])] : null
      return { text: interpolate(tr('Merged “{name}” into “{into}”'), { name, into }), undo }
    }
    case 'reorder': {
      const before = areas.filter((entry) => entry.status === 'kept' && !entry.mergedInto).map((entry) => entry.id)
      return { text: tr('Changed the order of your focus areas'), undo: [{ action: 'reorder', focusAreaIds: before }] }
    }
    case 'move-request': {
      const request = requests.find((entry) => entry.id === change.requestId)
      const from = request ? resolveFocusAreaId(request.focusAreaId, areas) : null
      const toLabel = focusAreaLabel(change.focusAreaId, areas)
      const toArea = resolveFocusAreaId(change.focusAreaId, areas) === OTHER_FOCUS_AREA_ID ? tr('Other') : toLabel
      return { text: interpolate(tr('Moved “{title}” to {area}'), { title: request?.title ?? tr('the request'), area: toArea }), undo: request && from ? [{ action: 'move-request', requestId: request.id, focusAreaId: from }] : null }
    }
    case 'restore-suggestion': return { text: interpolate(tr('Put “{name}” back in Suggested'), { name }), undo: null }
  }
}

export type FocusChanges = ReturnType<typeof useFocusChanges>

/** My Focus saves from the store, with each change described for the saved note while the screen still shows it. */
export function useFocusChanges() {
  const { t } = useI18n()
  const { focusAreas, requests } = useWorkModel()
  const { history, saving, error } = useStore.use.focus()
  const { applyFocusChange, undoLastFocusChange } = useStore.getState()
  /** `record: false` when the screen shows its own Undo for it (a decided suggestion card). Resolves true when saved. */
  const apply = (change: FocusChange, { record = true } = {}) => applyFocusChange(change, record ? describeFocusChange(change, focusAreas, requests, t) : null)
  return { last: history.at(-1) ?? null, apply, undoLast: undoLastFocusChange, error, saving }
}

/** The last change, where it was saved, and Undo; or why a change was not saved. */
export function FocusChangeBar({ changes }: { changes: FocusChanges }) {
  const { t } = useI18n()
  const { sourceKind } = useWorkModel()
  const { last, error, saving, undoLast } = changes
  return (
    <>
      {error && <p role="alert" className="border-l-2 border-attention-border py-1 pl-3 text-xs text-attention-foreground">{error}</p>}
      {last && (
        <Req ids={['R16.2', 'R13.7']}>
          <div role="status" className="space-y-1 border-l-2 border-shipped-border py-1 pl-3 text-xs">
            <p className="flex items-start gap-1.5 font-medium text-shipped-foreground"><CheckIcon className="mt-px size-3.5 shrink-0" />{last.text}.</p>
            <p className="text-muted-foreground">{sourceKind === 'sample' ? t('Wireframe: kept on this page only, not actually written.') : sourceKind === 'cloud' ? t('Saved in your cloud viewer; it syncs to your computers. A refresh never overrides it.') : t('Saved on this computer; it syncs to your other machines. A refresh never overrides it.')}</p>
            <div className="-ml-2 flex flex-wrap items-center gap-x-2">
              <Button variant="ghost" size="sm" className="h-11 text-xs sm:h-8" onClick={undoLast} disabled={!last.undo || saving}>{t('Undo')}</Button>
              {!last.undo && <span className="text-muted-foreground">{t('This one can’t be undone from here.')}</span>}
            </div>
          </div>
        </Req>
      )}
    </>
  )
}

export type AreaEdit = { kind: 'rename' | 'edit-goal' | 'merge'; area: FocusArea }

/** Rename, edit the goal, or choose the area to merge into. One dialog; the worker refuses what it cannot save.
 * `ownUndo` says which changes the screen shows its own Undo for; every other change goes to the shared change bar. */
export function AreaEditDialog({ edit, changes, onClose, onSaved, ownUndo }: {
  edit: AreaEdit | null; changes: FocusChanges; onClose: () => void; onSaved?: (change: FocusChange) => void; ownUndo?: (change: FocusChange) => boolean
}) {
  const { t } = useI18n()
  const { focusAreas } = useWorkModel()
  const [text, setText] = useState('')
  const [into, setInto] = useState('')
  const [openedFor, setOpenedFor] = useState<AreaEdit | null>(null)
  if (edit !== openedFor) {
    setOpenedFor(edit)
    setText(edit?.kind === 'rename' ? edit.area.name : edit?.kind === 'edit-goal' ? edit.area.goal ?? '' : '')
    setInto('')
  }
  if (!edit) return null
  const targets = focusAreas.filter((area) => isPlaceableFocusArea(area) && area.id !== edit.area.id)
  const navWord = edit.kind === 'rename' ? navWordIn(text) : null
  const change: FocusChange = edit.kind === 'merge' ? { action: 'merge', focusAreaId: edit.area.id, intoFocusAreaId: into }
    : edit.kind === 'rename' ? { action: 'rename', focusAreaId: edit.area.id, name: text } : { action: 'edit-goal', focusAreaId: edit.area.id, goal: text }
  const submit = async () => { if (await changes.apply(change, { record: !ownUndo?.(change) })) { onSaved?.(change); onClose() } }
  const title = edit.kind === 'rename' ? interpolate(t('Rename “{name}”'), { name: edit.area.name })
    : edit.kind === 'edit-goal' ? interpolate(t('Goal for “{name}”'), { name: edit.area.name })
    : interpolate(t('Merge “{name}” into…'), { name: edit.area.name })
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
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
            <Label htmlFor="merge-into">{t('Merge into')}</Label>
            <Select value={into} onValueChange={setInto}>
              <SelectTrigger id="merge-into" className="h-11 w-full sm:h-9"><SelectValue placeholder={t('Choose an area')} /></SelectTrigger>
              <SelectContent>{targets.map((area) => <SelectItem key={area.id} value={area.id}>{area.name}{area.status === 'suggested' ? t(' · suggested') : ''}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="area-text">{edit.kind === 'rename' ? t('Name') : t('Goal')}</Label>
            <Input id="area-text" value={text} maxLength={edit.kind === 'rename' ? MAX_AREA_NAME_CHARS : MAX_AREA_GOAL_CHARS} onChange={(event) => setText(event.target.value)} className="h-11 sm:h-9" />
            {navWord && <p className="text-xs text-attention-foreground">{interpolate(t('“{text}” reuses the page name “{navWord}”. Pick a name that means only this area.'), { text: text.trim(), navWord })}</p>}
          </div>
        )}
        {changes.error && <p role="alert" className="text-xs text-destructive">{changes.error}</p>}
        <DialogFooter>
          <Button variant="ghost" className="h-11 sm:h-9" onClick={onClose}>{t('Cancel')}</Button>
          <Button className="h-11 sm:h-9" disabled={changes.saving || (edit.kind === 'merge' ? !into : !text.trim() || !!navWord)} onClick={submit}>{changes.saving ? t('Saving…') : t('Save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
