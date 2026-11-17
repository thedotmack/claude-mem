import { t, useI18n, interpolate } from '@/lib/i18n'
// Suggested focus areas: the decision queue from My Rules, with Keep, Rename, Merge and Dismiss. A decided card shrinks
// at once to its one-line result (with Undo, through restore-suggestion) until you leave the page; a rename leaves the
// card undecided and shows in the change bar, with Undo back to the old name. On phones an undecided card swipes like
// My Rules' queue: right keeps, left dismisses.
import { useId, useMemo, useState } from 'react'
import { ArrowRightIcon, CheckIcon, CircleCheckIcon, CircleXIcon, LayersIcon, MergeIcon, PencilIcon, Undo2Icon, XIcon, type LucideIcon } from 'lucide-react'
import { Confirmation, ConfirmationAccepted, ConfirmationAction, ConfirmationActions, ConfirmationRejected, ConfirmationRequest, ConfirmationTitle } from '@/components/ai-elements/confirmation'
import { Button } from '@/components/ui/button'
import { StateBadge } from '@/components/bits'
import { AreaEditDialog, FocusChangeBar, useFocusChanges, type AreaEdit } from '@/components/focus-changes'
import { Quotes } from '@/components/focus-header'
import { MoreQuotesFold } from '@/components/more-quotes'
import { DECISION_CARD_BODY, STICKY_ABOVE_BOTTOM_BAR, SwipeHint, SwipeToDecide } from '@/components/swipe-to-decide'
import { READING_MEASURE } from '@/lib/reading-measure'
import { useIsPhone } from '@/lib/swipe-to-decide'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { type FocusArea, type Request } from '@/data'
import { useWorkModel } from '@/store'
import { resolveFocusAreaId, suggestionEditDecision, type SuggestionDecision } from '@/live/to-focus-model'

type Decision = SuggestionDecision
/** A decided area's result line, in words (the merged one names where it went). */
const DECISION_WORDS: Record<Decision, string> = {
  kept: 'Kept. It’s in My focus now.',
  merged: 'Merged into {name}. Its requests show there now.',
  dismissed: 'Dismissed. It won’t be suggested again, and its requests are sorted again.',
}
/** A decided area's marks: an icon and an edge colour as well as words (c-ai-confirmation M1). */
const DECISION_MARK: Record<Decision, { icon: LucideIcon; iconClass: string; edge: string; kept: boolean }> = {
  kept: { icon: CircleCheckIcon, iconClass: 'text-shipped-foreground', edge: 'border-shipped-border', kept: true },
  merged: { icon: CircleCheckIcon, iconClass: 'text-shipped-foreground', edge: 'border-shipped-border', kept: true },
  dismissed: { icon: CircleXIcon, iconClass: 'text-muted-foreground', edge: 'border-control-edge', kept: false },
}
/** Why the system suggested an area, when it recorded no evidence of its own. */
const SOURCE_TEXT: Record<FocusArea['source'], string> = {
  'owner-goals': 'owner-goals found it in your prompts', clustering: 'several Other requests read as steps of it',
  promotion: 'one request held several separate asks', seed: 'it was set up from how your requests were sorted before', owner: 'you wrote it',
}
// Plan Phase 7 (page-08 M1, c-suggested-suggestion-card M1): each card at most 760px wide.
const CARD_WIDTH = 'w-full max-w-[760px]'

/**
 * One suggested area, waiting (c-suggested-suggestion-card): its name as a heading, the goal at a readable width
 * (READING_MEASURE), then below them why it was suggested with its quotes, then the buttons: Keep (orange only on the
 * first card still waiting: one primary per screen, G1), Rename and Merge as quiet text buttons, Dismiss at the far
 * end, and one line saying what Keep and Dismiss do. On phones the buttons stick above the bottom bar inside the part
 * below the name and goal, so they never cover them. While a save is under way they wait, with a line saying for what
 * (G16).
 */
function SuggestionCard({ area, requests, primary, saving, onKeep, onDismiss, onEdit }: {
  area: FocusArea; requests: Request[]; primary: boolean; saving: boolean
  onKeep: () => void; onDismiss: () => void; onEdit: (edit: AreaEdit) => void
}) {
  const savingReasonId = useId()
  const [first, ...more] = area.quotes
  const waits = saving ? { 'aria-disabled': true, 'aria-describedby': savingReasonId } as const : {}
  return (
    <Req ids={['R16.4']}>
      <Confirmation id={`suggested-${area.id}`} data-slot="suggested-area-card" approval={{ id: area.id }} state="approval-requested"
        className={cn(CARD_WIDTH, 'gap-3 p-4 shadow-panel md:p-5')}>
        <div className="space-y-1">
          <h3 className="text-lg leading-snug font-semibold tracking-tight">{area.name}</h3>
          {area.goal && <p data-slot="area-goal" className={cn(READING_MEASURE, 'text-sm text-foreground/85')}>{area.goal}</p>}
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground tabular">
            <LayersIcon aria-hidden="true" className="size-3.5 shrink-0" />
            {requests.length ? interpolate(t('{count} placed in it'), { count: requests.length }) : t("No requests placed in it yet")}{area.asks.length ? interpolate(t(' · {count} not started'), { count: area.asks.length }) : ''}
          </p>
        </div>

        <div className={DECISION_CARD_BODY}>
          <p className={cn(READING_MEASURE, 'text-xs text-muted-foreground')}>{interpolate(t('Why it’s suggested: {reason}'), { reason: area.quotes.length === 0 && area.evidence ? area.evidence : `${t(SOURCE_TEXT[area.source])}.` })}</p>
          {first && <Quotes quotes={[first]} />}
          {more.length > 0 && <MoreQuotesFold count={more.length}><Quotes quotes={more} /></MoreQuotesFold>}

          <ConfirmationRequest>
            <Req ids={['R11.1']}>
              {/* Below the md width the buttons stay above the pinned bottom bar while the card is on screen (D9). */}
              <ConfirmationActions className={cn('w-full flex-wrap justify-start self-stretch border-t pt-3', STICKY_ABOVE_BOTTOM_BAR)}>
                <ConfirmationAction variant={primary ? 'default' : 'outline'} onClick={onKeep} {...waits}><CheckIcon />{t("Keep")}</ConfirmationAction>
                <ConfirmationAction variant="ghost" onClick={() => onEdit({ kind: 'rename', area })} {...waits}><PencilIcon />{t("Rename")}</ConfirmationAction>
                <ConfirmationAction variant="ghost" onClick={() => onEdit({ kind: 'merge', area })} {...waits}><MergeIcon />{t("Merge")}</ConfirmationAction>
                <ConfirmationAction variant="ghost" className="ml-auto" onClick={onDismiss} {...waits}><XIcon />{t("Dismiss")}</ConfirmationAction>
                {saving && <p id={savingReasonId} data-slot="decision-waits-for" className="basis-full text-xs text-muted-foreground">{t('Saving your last change. These buttons work again once it’s saved.')}</p>}
              </ConfirmationActions>
            </Req>
            <p className="text-xs text-muted-foreground">{t('Keep puts it in My focus. Dismiss stops it being suggested. Both can be undone.')}</p>
          </ConfirmationRequest>
        </div>
      </Confirmation>
    </Req>
  )
}

/**
 * A decided area, shrunk at once to its one-line result (c-aceternity-sparkles M1-M2, c-ai-confirmation M1): a check
 * or a cross and an edge colour as well as words, the whole name (never cut), then Show it and Undo as 44px outlined
 * buttons. No timer and no sparks (the sparkles stay on the setup launch screen).
 */
function DecidedArea({ area, decision, saving, onUndo, onShow }: { area: FocusArea; decision: Decision; saving: boolean; onUndo: () => void; onShow: () => void }) {
  const { focusAreas } = useWorkModel()
  const savingReasonId = useId()
  const { icon: Mark, iconClass, edge, kept } = DECISION_MARK[decision]
  const mergedInto = area.mergedInto ? focusAreas.find((entry) => entry.id === area.mergedInto)?.name : null
  return (
    <Req ids={['R16.4']}>
      <Confirmation id={`suggested-${area.id}`} data-slot="suggested-area-card" data-decision={decision} approval={{ id: area.id, approved: kept }} state="approval-responded"
        className={cn(CARD_WIDTH, 'flex-row flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5', edge)}>
        <Mark aria-hidden="true" className={cn('size-5 shrink-0', iconClass)} />
        <div className="min-w-0 flex-1 basis-48">
          <h3 data-slot="decided-area-name" className="text-sm font-semibold [overflow-wrap:anywhere]">{area.name}</h3>
          <ConfirmationAccepted>
            <ConfirmationTitle className="block text-xs text-shipped-foreground">{interpolate(t(DECISION_WORDS[decision]), { name: mergedInto ?? t('another area') })}</ConfirmationTitle>
          </ConfirmationAccepted>
          <ConfirmationRejected>
            <ConfirmationTitle className="block text-xs text-muted-foreground">{t(DECISION_WORDS[decision])}</ConfirmationTitle>
          </ConfirmationRejected>
        </div>
        <div className="flex gap-2">
          {kept && <Button variant="outline" onClick={onShow}><ArrowRightIcon />{t("Show it")}</Button>}
          <Button variant="outline" onClick={onUndo} aria-disabled={saving || undefined} aria-describedby={saving ? savingReasonId : undefined}><Undo2Icon />{t("Undo")}</Button>
        </div>
        {saving && <p id={savingReasonId} className="basis-full text-xs text-muted-foreground">{t('Saving your last change. Undo works again once it’s saved.')}</p>}
      </Confirmation>
    </Req>
  )
}

export function SuggestedAreas({ onOpenFocus }: { onOpenFocus: (focusAreaId: string) => void }) {
  useI18n()
  const { focusAreas, requests } = useWorkModel()
  const changes = useFocusChanges()
  const isPhone = useIsPhone()
  // Decisions made on this page stay in the queue (with Undo) until you leave; the saved rows are the truth.
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [edit, setEdit] = useState<AreaEdit | null>(null)
  const suggestions = useMemo(() => focusAreas.filter((area) => (area.status === 'suggested' && !area.mergedInto) || area.id in decisions), [focusAreas, decisions])
  const waiting = suggestions.filter((area) => !decisions[area.id]).length
  // The one orange Keep: the first card still waiting. It moves to the next after each decision (page-08 M2).
  const firstWaiting = suggestions.find((area) => !decisions[area.id])?.id ?? null
  const decide = async (area: FocusArea, decision: Extract<Decision, 'kept' | 'dismissed'>) => {
    if (await changes.apply({ action: decision === 'kept' ? 'keep' : 'dismiss', focusAreaId: area.id }, { record: false })) setDecisions((previous) => ({ ...previous, [area.id]: decision }))
  }
  const undo = async (area: FocusArea) => {
    if (await changes.apply({ action: 'restore-suggestion', focusAreaId: area.id }, { record: false })) setDecisions(({ [area.id]: _undone, ...rest }) => rest)
  }
  const inArea = (area: FocusArea) => requests.filter((request) => resolveFocusAreaId(request.focusAreaId, focusAreas) === area.id)
  return (
    <Req ids={['R16.4', 'R12.3', 'R12.2']}>
      <section aria-labelledby="suggested-heading" className="space-y-4">
        {/* The page's h1 is "Suggested" in the header bar; this is the queue's heading, and each area's name is an h3. */}
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 id="suggested-heading" className="text-lg font-semibold tracking-tight">{t("Suggested focus areas")}</h2>
            {waiting > 0 && <StateBadge state="your-move" />}
            <span aria-live="polite" className="text-sm text-muted-foreground tabular">{interpolate(t('{decided} of {total} decided'), { decided: suggestions.length - waiting, total: suggestions.length })}</span>
          </div>
          <p className={cn(READING_MEASURE, 'text-sm text-muted-foreground')}>{t("claude-mem suggests areas from your prompts and your requests. Keep the ones you’d ask for things inside of. A refresh never changes an area you decided.")}</p>
        </div>
        <FocusChangeBar changes={changes} />
        {suggestions.length === 0 ? (
          <Req ids={['R12.1']}>
            <p className="text-sm text-muted-foreground">{t("Nothing waiting. New suggestions show up here after the next refresh.")}</p>
          </Req>
        ) : (
          <>
            {isPhone && waiting > 0 && <SwipeHint>{t('Swipe right to keep, left to dismiss. Or use the buttons.')}</SwipeHint>}
            {/* Two columns from the xl width (1280px: media queries read the 16px initial size), so each card stays
                under 760px and its goal wraps. */}
            <ul className="grid items-start gap-4 xl:grid-cols-2">
              {suggestions.map((area) => {
                const decision = decisions[area.id]
                if (decision) return <li key={area.id}><DecidedArea area={area} decision={decision} saving={changes.saving} onUndo={() => undo(area)} onShow={() => onOpenFocus(area.mergedInto ?? area.id)} /></li>
                const card = <SuggestionCard area={area} requests={inArea(area)} primary={area.id === firstWaiting} saving={changes.saving}
                  onKeep={() => decide(area, 'kept')} onDismiss={() => decide(area, 'dismissed')} onEdit={setEdit} />
                // On phones an undecided card swipes, through the same handlers as its buttons.
                return (
                  <li key={area.id}>
                    {isPhone ? (
                      <SwipeToDecide disabled={changes.saving}
                        right={{ word: t('Keep'), swipeFurther: t('Swipe further to keep'), letGo: t('Let go to keep'), icon: CheckIcon, onDecide: () => void decide(area, 'kept') }}
                        left={{ word: t('Dismiss'), swipeFurther: t('Swipe further to dismiss'), letGo: t('Let go to dismiss'), icon: XIcon, onDecide: () => void decide(area, 'dismissed') }}>
                        {card}
                      </SwipeToDecide>
                    ) : card}
                  </li>
                )
              })}
            </ul>
          </>
        )}
        <AreaEditDialog edit={edit} changes={changes} onClose={() => setEdit(null)} ownUndo={(change) => suggestionEditDecision(change) !== null}
          onSaved={(change) => { const decision = suggestionEditDecision(change); if (decision && change.focusAreaId) setDecisions((previous) => ({ ...previous, [change.focusAreaId!]: decision })) }} />
      </section>
    </Req>
  )
}
