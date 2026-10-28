// Suggested focus areas: the decision queue from My Rules (DecisionQueue / SuggestionCard), with Keep, Rename, Merge
// and Dismiss. A decided card stays (with Undo, through restore-suggestion) until you leave the page; a rename leaves
// the card undecided and shows in the change bar, with Undo back to the old name.
import { useMemo, useState } from 'react'
import { CheckIcon, ChevronDownIcon, MergeIcon, PencilIcon, XIcon } from 'lucide-react'
import { Confirmation, ConfirmationAccepted, ConfirmationAction, ConfirmationActions, ConfirmationRejected, ConfirmationRequest, ConfirmationTitle, type ConfirmationProps } from '@/components/ai-elements/confirmation'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { StateBadge } from '@/components/bits'
import { AreaEditDialog, FocusChangeBar, useFocusChanges, type AreaEdit } from '@/components/focus-changes'
import { Quotes } from '@/components/focus-header'
import { cn } from '@/lib/utils'
import { plural } from '@/lib/words'
import { Req } from '@/spec/req'
import { useWorkModel, type FocusArea, type Request } from '@/data'
import { resolveFocusAreaId, suggestionEditDecision } from '@/live/to-focus-model'

type Decision = 'kept' | 'merged' | 'dismissed'
/** Why the system suggested an area, when it recorded no evidence of its own. */
const SOURCE_TEXT: Record<FocusArea['source'], string> = {
  'owner-goals': 'owner-goals found it in your prompts', clustering: 'several Other requests read as steps of it',
  promotion: 'one request held several separate asks', seed: 'it was set up from how your requests were sorted before', owner: 'you wrote it',
}

/** One suggested area: its name and goal, Keep / Rename / Merge / Dismiss first, then its evidence on demand. */
function SuggestionCard({ area, requests, decision, saving, onKeep, onDismiss, onEdit, onUndo, onShow }: {
  area: FocusArea; requests: Request[]; decision: Decision | undefined; saving: boolean
  onKeep: () => void; onDismiss: () => void; onEdit: (edit: AreaEdit) => void; onUndo: () => void; onShow: () => void
}) {
  const { focusAreas } = useWorkModel()
  const approval = (decision ? { id: area.id, approved: decision !== 'dismissed' } : { id: area.id }) as ConfirmationProps['approval']
  const [first, ...more] = area.quotes
  const mergedInto = area.mergedInto ? focusAreas.find((entry) => entry.id === area.mergedInto)?.name : null
  return (
    <Req ids={['R16.4']}>
      <Confirmation id={`suggested-${area.id}`} approval={approval} state={decision ? 'approval-responded' : 'approval-requested'}
        className={cn('gap-3 rounded-xl bg-card p-4 shadow-none', !decision ? 'border-review-border' : decision === 'dismissed' ? 'border-dashed' : 'border-shipped-border')}>
        <div className={cn('space-y-1', decision === 'dismissed' && 'line-through opacity-60')}>
          <p className="text-[15px] leading-snug font-semibold">{area.name}</p>
          {area.goal && <p className="text-sm text-foreground/85">{area.goal}</p>}
          <p className="text-xs text-muted-foreground">{requests.length ? `${plural(requests.length, 'request')} placed in it` : 'No requests placed in it yet'}{area.asks.length ? ` · ${plural(area.asks.length, 'ask')} not started` : ''}</p>
        </div>

        <ConfirmationRequest>
          <Req ids={['R11.1']}>
            <ConfirmationActions className="grid w-full grid-cols-2 gap-2 self-stretch sm:flex sm:w-auto sm:self-start">
              <ConfirmationAction className="h-11 sm:h-9" disabled={saving} onClick={onKeep}><CheckIcon />Keep</ConfirmationAction>
              <ConfirmationAction variant="outline" className="h-11 sm:h-9" disabled={saving} onClick={() => onEdit({ kind: 'rename', area })}><PencilIcon />Rename</ConfirmationAction>
              <ConfirmationAction variant="outline" className="h-11 sm:h-9" disabled={saving} onClick={() => onEdit({ kind: 'merge', area })}><MergeIcon />Merge</ConfirmationAction>
              <ConfirmationAction variant="ghost" className="h-11 sm:h-9" disabled={saving} onClick={onDismiss}><XIcon />Dismiss</ConfirmationAction>
            </ConfirmationActions>
          </Req>
        </ConfirmationRequest>
        <ConfirmationAccepted>
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <ConfirmationTitle className="text-sm text-shipped-foreground">{decision === 'merged' ? `Merged into ${mergedInto ?? 'another area'}. Its requests show there now.` : 'Kept. It’s in My focus now.'}</ConfirmationTitle>
            <div className="flex">
              <Button variant="ghost" size="sm" className="h-11 text-xs sm:h-8" onClick={onShow}>Show it</Button>
              <Button variant="ghost" size="sm" className="h-11 text-xs sm:h-8" disabled={saving} onClick={onUndo}>Undo</Button>
            </div>
          </div>
        </ConfirmationAccepted>
        <ConfirmationRejected>
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <ConfirmationTitle className="text-sm text-muted-foreground">Dismissed. It won’t be suggested again, and its requests are sorted again.</ConfirmationTitle>
            <Button variant="ghost" size="sm" className="h-11 text-xs sm:h-8" disabled={saving} onClick={onUndo}>Undo</Button>
          </div>
        </ConfirmationRejected>

        {!decision && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs text-muted-foreground">Why it’s suggested: {area.quotes.length === 0 && area.evidence ? area.evidence : `${SOURCE_TEXT[area.source]}.`}</p>
            {first && <Quotes quotes={[first]} />}
            {more.length > 0 && (
              <Collapsible>
                <CollapsibleContent className="pb-1"><Quotes quotes={more} /></CollapsibleContent>
                <CollapsibleTrigger className="group flex min-h-11 items-center gap-1 text-xs text-muted-foreground hover:text-foreground sm:min-h-8">
                  <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" /><span className="group-data-[state=open]:hidden">{more.length} more {more.length === 1 ? 'quote' : 'quotes'}</span><span className="hidden group-data-[state=open]:inline">Fewer quotes</span>
                </CollapsibleTrigger>
              </Collapsible>
            )}
          </div>
        )}
      </Confirmation>
    </Req>
  )
}

export function SuggestedAreas({ onOpenFocus }: { onOpenFocus: (focusAreaId: string) => void }) {
  const { focusAreas, requests } = useWorkModel()
  const changes = useFocusChanges()
  // Decisions made on this page stay in the queue (with Undo) until you leave; the saved rows are the truth.
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [edit, setEdit] = useState<AreaEdit | null>(null)
  const suggestions = useMemo(() => focusAreas.filter((area) => (area.status === 'suggested' && !area.mergedInto) || area.id in decisions), [focusAreas, decisions])
  const waiting = suggestions.filter((area) => !decisions[area.id]).length
  const decide = async (area: FocusArea, decision: 'kept' | 'dismissed') => {
    if (await changes.apply({ action: decision === 'kept' ? 'keep' : 'dismiss', focusAreaId: area.id }, { record: false })) setDecisions((previous) => ({ ...previous, [area.id]: decision }))
  }
  const undo = async (area: FocusArea) => {
    if (await changes.apply({ action: 'restore-suggestion', focusAreaId: area.id }, { record: false })) setDecisions(({ [area.id]: _undone, ...rest }) => rest)
  }
  const inArea = (area: FocusArea) => requests.filter((request) => resolveFocusAreaId(request.focusAreaId, focusAreas) === area.id)
  return (
    <Req ids={['R16.4', 'R12.3', 'R12.2']}>
      <section className="space-y-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-base font-semibold">Suggested focus areas</h2>
            {waiting > 0 && <StateBadge state="your-move" />}
            <span className="text-xs text-muted-foreground">{suggestions.length - waiting} of {suggestions.length} decided</span>
          </div>
          <p className="text-sm text-muted-foreground">claude-mem suggests areas from your prompts and your requests. Keep the ones you’d ask for things inside of. A refresh never changes an area you decided.</p>
        </div>
        <FocusChangeBar changes={changes} />
        {suggestions.length === 0 ? (
          <Req ids={['R12.1']}>
            <p className="text-sm text-muted-foreground">Nothing waiting. New suggestions show up here after the next refresh.</p>
          </Req>
        ) : (
          <div className="space-y-3">
            {suggestions.map((area) => (
              <SuggestionCard key={area.id} area={area} requests={inArea(area)} decision={decisions[area.id]} saving={changes.saving}
                onKeep={() => decide(area, 'kept')} onDismiss={() => decide(area, 'dismissed')} onEdit={setEdit} onUndo={() => undo(area)}
                onShow={() => onOpenFocus(area.mergedInto ?? area.id)} />
            ))}
          </div>
        )}
        <AreaEditDialog edit={edit} changes={changes} onClose={() => setEdit(null)} ownUndo={(change) => suggestionEditDecision(change) !== null}
          onSaved={(change) => { const decision = suggestionEditDecision(change); if (decision && change.focusAreaId) setDecisions((previous) => ({ ...previous, [change.focusAreaId!]: decision })) }} />
      </section>
    </Req>
  )
}
