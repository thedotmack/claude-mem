// Saving My Focus changes from the screen: one change at a time (a second click while one is saving does nothing),
// the last change shown with Undo (copied from My Rules' saved note), and the Rename / Edit goal / Merge dialog.
// Undo writes the change that puts things back, where the worker allows one: restore-suggestion for an area that was a
// suggestion (and the only way to undo a merge), keep / done / dismiss for a decided area, the old name or goal.
import { useState } from 'react'
import { CheckIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Req } from '@/spec/req'
import type { FocusArea, FocusChange, Request } from '@/data'
import { useStore, useWorkModel, type FocusChangeRecord } from '@/store'
import { focusAreaLabel, isPlaceableFocusArea, resolveFocusAreaId } from '@/live/to-focus-model'
import { navWordIn } from '../../../../services/work-view/nav-words.mjs'
import { useTranslation } from '@/i18n/use-translation'

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
function describeFocusChange(change: FocusChange, areas: FocusArea[], requests: Request[]): FocusChangeRecord {
  const area = areas.find((entry) => entry.id === change.focusAreaId)
  const name = `“${area?.name ?? 'the area'}”`
  switch (change.action) {
    case 'keep': return { text: `Kept ${name}`, undo: area ? backTo(area) : null }
    case 'dismiss': return { text: `Dismissed ${name}`, undo: area ? backTo(area) : null }
    case 'done': return { text: `Marked ${name} done`, undo: area ? backTo(area) : null }
    case 'rename': return { text: `Renamed ${name} to “${change.name?.trim()}”`, undo: area ? [{ action: 'rename', focusAreaId: area.id, name: area.name }] : null }
    case 'edit-goal': return { text: `Changed the goal of ${name}`, undo: area?.goal ? [{ action: 'edit-goal', focusAreaId: area.id, goal: area.goal }] : null }
    case 'merge': {
      const into = areas.find((entry) => entry.id === change.intoFocusAreaId)?.name ?? 'another area'
      // Only restore-suggestion clears a merge; a kept or done area is then decided again as it was.
      const undo = area && area.source !== 'owner' ? [{ action: 'restore-suggestion' as const, focusAreaId: area.id }, ...(area.status === 'suggested' ? [] : backTo(area) ?? [])] : null
      return { text: `Merged ${name} into “${into}”`, undo }
    }
    case 'reorder': {
      const before = areas.filter((entry) => entry.status === 'kept' && !entry.mergedInto).map((entry) => entry.id)
      return { text: 'Changed the order of your focus areas', undo: [{ action: 'reorder', focusAreaIds: before }] }
    }
    case 'move-request': {
      const request = requests.find((entry) => entry.id === change.requestId)
      const from = request ? resolveFocusAreaId(request.focusAreaId, areas) : null
      return { text: `Moved “${request?.title ?? 'the request'}” to ${focusAreaLabel(change.focusAreaId, areas)}`, undo: request && from ? [{ action: 'move-request', requestId: request.id, focusAreaId: from }] : null }
    }
    case 'restore-suggestion': return { text: `Put ${name} back in Suggested`, undo: null }
  }
}

export type FocusChanges = ReturnType<typeof useFocusChanges>

/** My Focus saves from the store, with each change described for the saved note while the screen still shows it. */
export function useFocusChanges() {
  const { focusAreas, requests } = useWorkModel()
  const { history, saving, error } = useStore.use.focus()
  const { applyFocusChange, undoLastFocusChange } = useStore.getState()
  /** `record: false` when the screen shows its own Undo for it (a decided suggestion card). Resolves true when saved. */
  const apply = (change: FocusChange, { record = true } = {}) => applyFocusChange(change, record ? describeFocusChange(change, focusAreas, requests) : null)
  return { last: history.at(-1) ?? null, apply, undoLast: undoLastFocusChange, error, saving }
}

/** The last change, where it was saved, and Undo; or why a change was not saved. */
export function FocusChangeBar({ changes }: { changes: FocusChanges }) {
  const { sourceKind } = useWorkModel()
  const { t } = useTranslation()
  const { last, error, saving, undoLast } = changes
  return (
    <>
      {error && <p role="alert" className="border-l-2 border-attention-border py-1 pl-3 text-xs text-attention-foreground">{error}</p>}
      {last && (
        <Req ids={['R16.2', 'R13.7']}>
          <div role="status" className="space-y-1 border-l-2 border-shipped-border py-1 pl-3 text-xs">
            <p className="flex items-start gap-1.5 font-medium text-shipped-foreground"><CheckIcon className="mt-px size-3.5 shrink-0" />{last.text}.</p>
            <p className="text-muted-foreground">{sourceKind === 'sample' ? 'Wireframe: kept on this page only, not actually written.' : sourceKind === 'cloud' ? 'Saved in your cloud viewer; it syncs to your computers. A refresh never overrides it.' : 'Saved on this computer; it syncs to your other machines. A refresh never overrides it.'}</p>
            <div className="-ml-2 flex flex-wrap items-center gap-x-2">
              <Button variant="ghost" size="sm" className="h-11 text-xs sm:h-8" onClick={undoLast} disabled={!last.undo || saving}>{t('detail.undo')}</Button>
              {!last.undo && <span className="text-muted-foreground">{t('dialog.cantUndo')}</span>}
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
  const { focusAreas } = useWorkModel()
  const { t, language } = useTranslation()
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
  const title = edit.kind === 'rename' ? (language === 'zh-CN' ? `重命名“${edit.area.name}”` : `Rename “${edit.area.name}”`)
    : edit.kind === 'edit-goal' ? (language === 'zh-CN' ? `“${edit.area.name}”的目标` : `Goal for “${edit.area.name}”`)
    : (language === 'zh-CN' ? `将“${edit.area.name}”合并到…` : `Merge “${edit.area.name}” into…`)
  const description = edit.kind === 'rename' ? t('dialog.renameDesc')
    : edit.kind === 'edit-goal' ? t('dialog.goalDesc')
    : t('dialog.mergeDesc', { name: edit.area.name })
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {edit.kind === 'merge' ? (
          <div className="space-y-2">
            <Label htmlFor="merge-into">{t('dialog.mergeInto')}</Label>
            <Select value={into} onValueChange={setInto}>
              <SelectTrigger id="merge-into" className="h-11 w-full sm:h-9"><SelectValue placeholder={t('dialog.chooseArea')} /></SelectTrigger>
              <SelectContent>{targets.map((area) => <SelectItem key={area.id} value={area.id}>{area.name}{area.status === 'suggested' ? ` · ${t('rules.statusSuggested')}` : ''}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="area-text">{edit.kind === 'rename' ? t('dialog.name') : t('dialog.goal')}</Label>
            <Input id="area-text" value={text} maxLength={edit.kind === 'rename' ? MAX_AREA_NAME_CHARS : MAX_AREA_GOAL_CHARS} onChange={(event) => setText(event.target.value)} className="h-11 sm:h-9" />
            {navWord && <p className="text-xs text-attention-foreground">“{text.trim()}” reuses the page name “{navWord}”. Pick a name that means only this area.</p>}
          </div>
        )}
        {changes.error && <p role="alert" className="text-xs text-destructive">{changes.error}</p>}
        <DialogFooter>
          <Button variant="ghost" className="h-11 sm:h-9" onClick={onClose}>{t('dialog.cancel')}</Button>
          <Button className="h-11 sm:h-9" disabled={changes.saving || (edit.kind === 'merge' ? !into : !text.trim() || !!navWord)} onClick={submit}>{changes.saving ? t('dialog.saving') : t('dialog.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
