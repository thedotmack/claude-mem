// Planning help: one click asks the owner's agent to look over the focus areas (or one of them) and suggest changes.
// Every suggestion waits for its own Accept, which saves it as the owner's ordinary focus change; nothing else applies one.
import { useState } from 'react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Req } from '@/spec/req'
import { useStore, useWorkModel } from '@/store'
import { planItems, type PlanItem } from '@/live/plan-items'
import type { PlanProposalKind, PlanState } from '../../../../services/work-view/owner-runs.mjs'
import type { FocusChanges } from './focus-changes'
import { INITIATIVE_WORDS } from '@/live/initiative-words'

const PLAN_STATE: Record<PlanState, string> = { planning: 'Planning…', ready: 'Plan ready', failed: 'Planning failed' }
const PROPOSAL_KIND: Record<PlanProposalKind, string> = { reorder: 'Order', initiative: INITIATIVE_WORDS.name, goal: 'Goal', notes: 'Notes', 'next-asks': 'Next ask' }
const CONTROL = 'h-11 shrink-0 md:h-7'

/** The button that starts a plan for one area, or for all of them (null), and where that plan stands. */
export function PlanButton({ focusAreaId }: { focusAreaId: string | null }) {
  const { t } = useI18n()
  const plan = useWorkModel().focusPlan
  const [refusal, setRefusal] = useState<string | null>(null)
  // A viewer whose source has no planning help says nothing about plans.
  if (plan === undefined) return null
  const mine = plan?.focusAreaId === focusAreaId ? plan : null
  const start = async () => {
    setRefusal(null)
    try {
      const started = await useStore.getState().planFocus(focusAreaId)
      if (started.outcome === 'refused') setRefusal(started.reason)
    } catch (error) { setRefusal(error instanceof Error ? error.message : String(error)) }
  }
  const status = refusal ?? (mine && (mine.state === 'failed' && mine.error ? `${t(PLAN_STATE.failed)}: ${mine.error}` : t(PLAN_STATE[mine.state])))
  return (
    <Req ids={['R19.16']}>
      <span className="inline-flex min-w-0 items-center gap-2">
        {status && <span role="status" className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">{!refusal && mine?.state === 'planning' && <Spinner className="size-3.5" />}{status}</span>}
        <Button variant="outline" size="sm" className={CONTROL} disabled={plan?.state === 'planning'} onClick={() => void start()}>{t(focusAreaId === null ? 'Plan my focuses' : 'Plan this focus')}</Button>
      </span>
    </Req>
  )
}

function Proposal({ item, changes, onDone }: { item: PlanItem; changes: FocusChanges; onDone: () => void }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null)
  const { change } = item
  const accept = async () => { if (change && await changes.apply(change)) onDone() }
  const copy = () => navigator.clipboard.writeText(item.text).then(() => setCopied('copied'), () => setCopied('failed'))
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2">
      <div className="min-w-0 flex-1 basis-72 space-y-0.5">
        <p className="text-sm leading-snug whitespace-pre-wrap"><span className="text-muted-foreground">{t(PROPOSAL_KIND[item.kind])}{item.areaName ? ` · ${item.areaName}` : ''}</span> {item.text}</p>
        {item.reasons.map((reason, index) => <p key={index} className="text-xs text-muted-foreground">{reason}</p>)}
      </div>
      <span className="inline-flex items-center gap-1">
        {change
          ? <Button variant="outline" size="sm" className={CONTROL} disabled={changes.saving} onClick={() => void accept()}>{t('Accept')}</Button>
          : <Button variant="outline" size="sm" className={CONTROL} onClick={() => void copy()}><span role="status">{copied === 'copied' ? t('Copied') : copied === 'failed' ? t('Couldn’t copy') : t('Copy')}</span></Button>}
        <Button variant="ghost" size="sm" className={CONTROL} onClick={onDone}>{t('Dismiss')}</Button>
      </span>
    </li>
  )
}

/** The ready plan's proposals for this scope. Dismiss hides one on this page only; a new plan shows all of its own. */
export function PlanProposals({ focusAreaId, changes, className }: { focusAreaId: string | null; changes: FocusChanges; className?: string }) {
  const { t } = useI18n()
  const { focusAreas } = useWorkModel()
  const plan = useStore((state) => state.work.focusPlan)
  const [hidden, setHidden] = useState<{ plan: string | null; keys: ReadonlySet<string> }>({ plan: null, keys: new Set() })
  if (!plan || plan.state !== 'ready' || plan.focusAreaId !== focusAreaId) return null
  const hiddenKeys = hidden.plan === plan.generatedAt ? hidden.keys : new Set<string>()
  const items = planItems(plan, focusAreas).filter((item) => !hiddenKeys.has(item.key))
  const hide = (key: string) => setHidden({ plan: plan.generatedAt, keys: new Set([...hiddenKeys, key]) })
  if (items.length === 0 && plan.skipped.length === 0) return null
  return (
    <Req ids={['R19.16']}>
      <div className={className}>
        <ul className="divide-y divide-border/70">
          {items.map((item) => <Proposal key={item.key} item={item} changes={changes} onDone={() => hide(item.key)} />)}
        </ul>
        {plan.skipped.length > 0 && <p className="py-1 text-xs text-muted-foreground" title={plan.skipped.join('\n')}>{interpolate(t(plan.skipped.length === 1 ? '{count} suggestion left out' : '{count} suggestions left out'), { count: plan.skipped.length })}</p>}
      </div>
    </Req>
  )
}
