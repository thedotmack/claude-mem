import { displayTime } from '@/lib/display-time'
import { getLocale, t, useI18n, interpolate } from '@/lib/i18n'
import { uiMessage, renderUiMessage, type UiMessage } from '../../../ui-message'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, CircleCheckIcon, CircleXIcon, CloudIcon, CopyIcon, EyeIcon, FileTextIcon, GlobeIcon, LaptopIcon, PencilIcon, PlusIcon, RefreshCcwIcon, RefreshCwIcon, SaveIcon, SparklesIcon, TriangleAlertIcon, Undo2Icon, XIcon, type LucideIcon } from 'lucide-react'
import { Artifact, ArtifactActions, ArtifactContent, ArtifactHeader, ArtifactTitle } from '@/components/ai-elements/artifact'
import { Confirmation, ConfirmationAccepted, ConfirmationAction, ConfirmationActions, ConfirmationRejected, ConfirmationRequest, ConfirmationTitle } from '@/components/ai-elements/confirmation'
import { InlineCitation, InlineCitationCard, InlineCitationCardBody, InlineCitationCardTrigger, InlineCitationText } from '@/components/ai-elements/inline-citation'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FieldHelperText, Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { LIST_ROWS_PER_PAGE, TablePageFooter } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ManualRefreshButton, RefreshButton, RefreshStatus, StateBadge } from '@/components/bits'
import { DECISION_CARD_BODY, STICKY_ABOVE_BOTTOM_BAR, SwipeHint, SwipeToDecide } from '@/components/swipe-to-decide'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { ErrorDetails } from '@/components/error-details'
import { MoreQuotesFold } from '@/components/more-quotes'
import { useIsPhone } from '@/lib/swipe-to-decide'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { SAMPLE_DEVICES, SAMPLE_RUNS, type SkillRun } from '@/data'
import { type RuleChangeRecord, type RuleSaveOutcome, useStore, useWorkModel, useWorkspace } from '@/store'
import { RULE_CHANGED_SINCE_EDIT } from '@/store/slices/rules-slice'
import { RULE_TIERS, type OwnerRule, type RuleChange, type RuleQuote, type RuleRecord, type RuleRecordFact, type RuleScope, type RuleStatus, type RuleTier, type RulesLearning } from '@/data-rules'
import { addedRuleFromSave, currentRuleDecisions, ruleUndoIsCurrent, type RuleDecision } from '@/live/rule-actions'
import { currentIn, inShownOrder, keepShownOrder, stepFrom, upNextAfter } from '@/live/rule-queue'
import type { AutoRefresh, RuleSaveResult } from '@/live/work-data-source'

// ---------- Derived facts ----------

/** A rule's scope from the loaded scopes. Fails fast: the mapper only lets through rules whose scope is listed. */
function useRuleScope(scopeId: string): RuleScope {
  const scope = useWorkModel().ruleScopes.find((entry) => entry.id === scopeId)
  if (!scope) throw new Error(`No rule scope ${scopeId}`)
  return scope
}
const scopeHeading = (scope: RuleScope) => scope.tier === 'everywhere' ? 'Everywhere' : scope.tier === 'project' ? `In ${scope.name}` : scope.name
const displayScope = (scope: RuleScope) => scope.tier === 'everywhere' ? t('Everywhere') : scope.tier === 'project' ? interpolate(t('In {name}'), { name: scope.name }) : scope.name

/** Strength (§14): times seen × how recent. Shown in words, never as a raw score. */
const strengthScore = (rule: OwnerRule) => rule.timesSeen / (1 + rule.latestDaysAgo / 7)
/** A rule's strength in words. The one definition: the meter, the words, the filter chips and the queue's rows use it. */
const RULE_STRENGTHS = ['strong', 'steady', 'light'] as const
type RuleStrength = (typeof RULE_STRENGTHS)[number]
const RULE_STRENGTH_WORDS: Record<RuleStrength, string> = { strong: 'Strong', steady: 'Steady', light: 'Light' }
/** How many of the meter's three bars are lit. */
const RULE_STRENGTH_BARS: Record<RuleStrength, number> = { strong: 3, steady: 2, light: 1 }
// R14.14's bands, unchanged: a score of 4 is about four sightings this week; 1.5 is one this week, or a few weeks ago.
const strengthOf = (rule: OwnerRule): RuleStrength => { const score = strengthScore(rule); return score >= 4 ? 'strong' : score >= 1.5 ? 'steady' : 'light' }
const byStrength = (a: OwnerRule, b: OwnerRule) => strengthScore(b) - strengthScore(a)
/** What the queue shows: every waiting rule, or one strength (c-rules-decision-queue M2). The one definition: the chips are drawn from it. */
const STRENGTH_FILTERS = ['all', ...RULE_STRENGTHS] as const
type StrengthFilter = (typeof STRENGTH_FILTERS)[number]
const isStrengthFilter = (value: string): value is StrengthFilter => STRENGTH_FILTERS.some((filter) => filter === value)
const STRENGTH_FILTER_WORDS: Record<StrengthFilter, string> = { all: 'All', ...RULE_STRENGTH_WORDS }

/** A decided rule, in words and marks (an icon and an edge colour as well as words: c-ai-confirmation M1). */
const RULE_DECISION_WORDS: Record<RuleDecision, string> = { approved: 'Approved', rejected: 'Rejected' }
const RULE_DECISION_MARK: Record<RuleDecision, { icon: LucideIcon; iconClass: string; edge: string }> = {
  approved: { icon: CircleCheckIcon, iconClass: 'text-shipped-foreground', edge: 'border-shipped-border' },
  rejected: { icon: CircleXIcon, iconClass: 'text-muted-foreground', edge: 'border-control-edge' },
}

const RULE_STATUS_WORDS: Record<RuleStatus, string> = { on: 'On', off: 'Off', suggested: 'Suggested', replaced: 'Replaced', dismissed: 'Rejected' }
const setByText = (rule: OwnerRule) => t(rule.setBy === 'owner' ? 'Set by you' : rule.setBy === 'approved' ? 'Learned, approved by you' : 'Learned, not approved yet')
const sourceText = (rule: OwnerRule) => rule.source === 'you' ? t('From your own instructions.') : interpolate(t('Found by {source}.'), { source: rule.source })
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)
const scrollToId = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
/** The rule as one line, the way MY-RULES.md writes it (rulesFileLines below). */
const ruleLine = (rule: Pick<OwnerRule, 'when' | 'then'>) => rule.when.trim() ? interpolate(t('When {when}: {then}'), { when: rule.when.trim(), then: lowerFirst(rule.then.trim()) }) : rule.then.trim()

function ruleReceipt(source: string, values: UiMessage['values']) {
  const message = uiMessage(source, values)
  return { text: renderUiMessage(message, source => source), message }
}

function renderRuleReceipt(record: Pick<RuleChangeRecord, 'text'> & { message?: UiMessage }) {
  return record.message ? renderUiMessage(record.message, t) : record.text
}

// ---------- Small pieces ----------

/** The if-then block, read as one plain-English sentence split across two aligned lines (§14). */
function RuleSentence({ rule, large = false, id }: { rule: OwnerRule; large?: boolean; id?: string }) {
  return (
    <Req ids={['R14.3', 'R10.5']}>
      <dl id={id} className={cn('grid grid-cols-[3rem_1fr] gap-x-2 gap-y-0.5', large ? 'text-[1.0625rem] leading-snug' : 'text-sm')}>
        {rule.when ? <>
          <dt className="pt-px text-xs font-medium text-muted-foreground">{t("When")}</dt>
          <dd className="text-muted-foreground">{rule.when}</dd>
          <dt className="pt-px text-xs font-medium text-muted-foreground">{t("Then")}</dt>
          <dd className={cn('leading-snug', large ? 'font-semibold' : 'font-medium')}>{lowerFirst(rule.then)}</dd>
        </> : <>
          {/* A learned preference is one sentence: no "when" was recorded, and none is made up. */}
          <dt className="pt-px text-xs font-medium text-muted-foreground">{t("Always")}</dt>
          <dd className={cn('leading-snug', large ? 'font-semibold' : 'font-medium')}>{rule.then}</dd>
        </>}
      </dl>
    </Req>
  )
}

/** Status uses the same state language as My Work (§6): on reads as shipped, suggested as waiting for a check. */
function RuleStatusBadge({ rule, justApproved }: { rule: OwnerRule; justApproved?: boolean }) {
  const label = justApproved ? t("Approved just now") : t(RULE_STATUS_WORDS[rule.status])
  return (
    <Req ids={['R14.3', 'R6.2']}>
      <span className={cn('inline-flex items-center gap-1.5 font-medium', {
        'text-shipped-foreground': rule.status === 'on',
        'text-review-foreground': rule.status === 'suggested',
        'text-muted-foreground': rule.status === 'off' || rule.status === 'replaced' || rule.status === 'dismissed',
      })}>
        <span className={cn('size-1.5 rounded-full', rule.status === 'on' ? 'bg-shipped-foreground' : rule.status === 'suggested' ? 'bg-review-foreground' : 'bg-idle-foreground')} />
        {label}
      </span>
    </Req>
  )
}

/** The three-step strength meter; the words beside it carry the strength for screen readers. */
function StrengthBars({ rule }: { rule: OwnerRule }) {
  const lit = RULE_STRENGTH_BARS[strengthOf(rule)]
  return (
    <span className="flex shrink-0 items-end gap-0.5" aria-hidden="true">
      {[1, 2, 3].map((step) => <span key={step} className={cn('w-1 rounded-full', step === 1 ? 'h-1.5' : step === 2 ? 'h-2' : 'h-2.5', step <= lit ? 'bg-current' : 'bg-idle-border')} />)}
    </span>
  )
}

/** Strength in human terms: a three-step meter, the word, times seen and the latest date (§14), in tabular figures. */
function Strength({ rule }: { rule: OwnerRule }) {
  return (
    <Req ids={['R14.14', 'R14.7']}>
      <span className="inline-flex items-center gap-1.5">
        <StrengthBars rule={rule} />
        <span className="tabular">{interpolate(t(rule.timesSeen === 1 ? '{strength} · said {timesSeen} time, latest {latestAt}' : '{strength} · said {timesSeen} times, latest {latestAt}'), { strength: t(RULE_STRENGTH_WORDS[strengthOf(rule)]), timesSeen: rule.timesSeen, latestAt: displayTime(rule.latestAt) })}</span>
      </span>
    </Req>
  )
}

/** What a quote's source row calls it: a prompt you typed, or a line of your instructions file. */
const QUOTE_WHERE_WORDS: Record<RuleQuote['where'], string> = { prompt: 'Your prompt', 'CLAUDE.md': 'Your instructions file' }
/** The kind request-progress gave the preference, in words the page already uses (c-ai-inline-citation F6). */
const QUOTE_KIND_WORDS: Record<RuleQuote['kind'], string> = { directive: 'Instruction', correction: 'Correction', praise: 'Praise', frustration: 'Frustration' }

/** A record's kind, in words. */
const RULE_RECORD_KIND_WORDS: Record<RuleRecord['kind'], string> = { Prompt: 'Prompt', Review: 'Review', 'Goals run': 'Goals run', Instructions: 'Instructions' }
/** What a mapped record is, in words (Phase 0: the mapper's English is not shown as data). `{quote}`: the prompt in full. */
const RULE_RECORD_FACT_WORDS: Record<RuleRecordFact, string> = {
  'your-prompt': '“{quote}”',
  'build-story': 'request-progress · build story',
  'written-here': 'Written in My Rules on this computer',
  'saved-here': 'Saved in My Rules on this computer',
}
/** A record's text: the words for what it is, else its own label (sample records, and workers before 16.0.0: G19). */
const recordText = (record: RuleRecord) => !record.fact || (record.fact === 'your-prompt' && !record.said)
  ? record.label
  : interpolate(t(RULE_RECORD_FACT_WORDS[record.fact]), { quote: record.said ?? '' })

/**
 * The rows behind a quote's time chip (c-ai-inline-citation M3): kind, text and time, every quote in full (no "…"), then
 * the records that are not those quotes. A prompt record is the same prompt as the quote typed at its time, so it is
 * not repeated under a doubled "Prompt: Your prompt:" (F4); the whole list stays under Source records.
 */
function sourceRows(rule: OwnerRule, current: RuleQuote) {
  const quoteTimes = new Set(rule.quotes.map((quote) => quote.at))
  return [
    ...rule.quotes.map((quote) => ({ key: `quote:${quote.at}:${quote.quote}`, kind: t(QUOTE_WHERE_WORDS[quote.where]), text: `“${quote.quote}”`, at: quote.at, current: quote === current })),
    ...rule.records.filter((record) => !(record.kind === 'Prompt' && quoteTimes.has(record.at)))
      .map((record) => ({ key: `record:${record.kind}:${record.label}:${record.at}`, kind: t(RULE_RECORD_KIND_WORDS[record.kind]), text: recordText(record), at: record.at, current: false })),
  ]
}

/** One dated quote: the owner's words, then its time as a button that opens where the rule came from. */
function Quote({ quote, rule }: { quote: RuleQuote; rule: OwnerRule }) {
  const titleId = useId()
  const [open, setOpen] = useState(false)
  return (
    <Req ids={['R14.3', 'R14.8']}>
      <blockquote className="grid items-start gap-x-4 gap-y-1 border-l-2 border-review-border pl-3 text-sm leading-snug sm:grid-cols-[minmax(0,1fr)_auto]">
        <InlineCitation>
          <InlineCitationText>“{quote.quote}”</InlineCitationText>
        </InlineCitation>
        <InlineCitationCard open={open} onOpenChange={setOpen}>
          <InlineCitationCardTrigger sources={[displayTime(quote.at)]} className="mono-number ml-0 w-fit justify-self-start sm:justify-self-end">
            <span className="sr-only">{t('Source records')}</span>
          </InlineCitationCardTrigger>
          <InlineCitationCardBody aria-labelledby={titleId} align="end" className="w-[min(36rem,calc(100vw-2rem))] p-0">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
              <p id={titleId} className="section-label">{t('Source records')}</p>
              <Button variant="ghost" size="icon-sm" aria-label={t('Close')} onClick={() => setOpen(false)}><XIcon /></Button>
            </div>
            <table className="w-full text-xs">
              <tbody>
                {sourceRows(rule, quote).map((row) => (
                  <tr key={row.key} aria-current={row.current || undefined} className={cn('border-b last:border-b-0 align-top', row.current && 'bg-muted')}>
                    <th scope="row" className="w-28 px-4 py-2 text-left font-medium text-muted-foreground">
                      {row.kind}
                      {row.current && <span className="block font-normal">{interpolate(t('This quote · {kind}'), { kind: t(QUOTE_KIND_WORDS[quote.kind]) })}</span>}
                    </th>
                    <td className="py-2 pr-3 text-foreground">{row.text}</td>
                    <td className="mono-number py-2 pr-4 text-right whitespace-nowrap text-muted-foreground">{displayTime(row.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </InlineCitationCardBody>
        </InlineCitationCard>
      </blockquote>
    </Req>
  )
}

/** Saving a long rule can omit evidence even while this computer still has the original story. */
export function RuleEvidenceNotice({ rule }: { rule: OwnerRule }) {
  const count = rule.quotesOmitted ?? 0
  if (count === 0) return null
  return <p className="text-xs text-review-foreground">{interpolate(t(count === 1
    ? '{count} supporting quote could not fit in this saved rule. Other devices may show fewer quotes.'
    : '{count} supporting quotes could not fit in this saved rule. Other devices may show fewer quotes.'), { count })}</p>
}

/** Each quote once, with its time in one column on the right (c-rules-rule-block M1). */
export function RuleEvidence({ rule }: { rule: OwnerRule }) {
  return <div className="space-y-2">
    {rule.quotes.length ? rule.quotes.map((quote) => <Quote key={quote.quote} quote={quote} rule={rule} />)
      : <p className="text-xs text-muted-foreground">{t(rule.source === 'you'
        ? 'You wrote this rule in My Rules, so there are no quotes behind it.'
        : 'No supporting quotes are available on this computer.')}</p>}
  </div>
}

/** Third layer of disclosure: the records the rule was built from (§14), folded to one row with its count (M2). */
function SourceRecords({ rule }: { rule: OwnerRule }) {
  if (rule.records.length === 0) return null
  return (
    <Req ids={['R14.8']}>
      <Collapsible>
        <CollapsibleFoldTrigger count={interpolate(t(rule.records.length === 1 ? '{count} record' : '{count} records'), { count: rule.records.length })}>{t("Source records")}</CollapsibleFoldTrigger>
        <CollapsibleContent>
          <table className="mt-2 w-full text-xs text-muted-foreground">
            <tbody>
              {rule.records.map((record) => (
                <tr key={`${record.kind}:${record.label}:${record.at}`} className="border-b last:border-b-0 align-top">
                  <th scope="row" className="w-24 py-1.5 pr-3 text-left font-medium text-foreground/80">{t(RULE_RECORD_KIND_WORDS[record.kind])}</th>
                  <td className="py-1.5 pr-3">{recordText(record)}</td>
                  <td className="mono-number py-1.5 text-right whitespace-nowrap">{displayTime(record.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CollapsibleContent>
      </Collapsible>
    </Req>
  )
}

// ---------- Where changes are saved (§13.5, decision 7) ----------

const HERE = SAMPLE_DEVICES.find((device) => device.syncedMinutesAgo === 0)!
/** Machine names as one list in the reader's language ("A and B", "A et B"), not joined with an English word. */
const machineList = (names: string[]) => new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(names)
/** Says where a change is written and how it reaches the other machines. Never claims more than that. */
const savedWhere = (mode: 'home' | 'web', sample: boolean) => !sample
  ? mode === 'web'
    ? t('Saved in your cloud viewer as a work-state record. It syncs to your computers, and each rebuilds MY-RULES.md when it pulls it')
    : t('Saved on this computer as a work-state record. MY-RULES.md is rebuilt here, and the record syncs with the rest of your work state')
  : mode === 'web'
    ? interpolate(t('Saved from the web as a “web” device record. {machines} pull it on their next sync and rebuild MY-RULES.md'), { machines: machineList(SAMPLE_DEVICES.map((device) => device.name)) })
    : interpolate(t('Saved on {name}. MY-RULES.md is rebuilt here, and the change syncs to {machines}'), { name: HERE.name, machines: machineList(SAMPLE_DEVICES.filter((device) => device.id !== HERE.id).map((device) => device.name)) })

// ---------- Rule blocks ----------

interface RuleActions {
  saving: boolean
  onToggle: (rule: OwnerRule, on: boolean) => void
  onEdit: (rule: OwnerRule) => void
  onJump: (ruleId: string) => void
  /** Puts a rejected rule back in Needs your decision. */
  onRestore: (rule: OwnerRule) => void
}

/** The last switch of a rule, shown on that rule with its Undo (c-rules-rule-block F6). */
interface ToggleResult { ruleId: string; on: boolean; canUndo: boolean; onUndo: () => void }

/** An owner rule: the sentence with its switch and pencil, then strength and who set it, then why on demand. */
function RuleBlock({ rule, replaces, justApproved, highlighted, toggled, actions }: { rule: OwnerRule; replaces: OwnerRule[]; justApproved: boolean; highlighted: boolean; toggled: ToggleResult | null; actions: RuleActions }) {
  const sentenceId = useId()
  const off = rule.status === 'off'
  return (
    <Req ids={['R14.3', 'R14.9', 'R10.2']}>
      <Collapsible asChild>
        <article id={`rule-${rule.id}`} className={cn('px-4 py-3 first:rounded-t-xl last:rounded-b-xl motion-safe:transition-colors motion-safe:duration-700', off ? 'bg-muted/50' : 'bg-card', highlighted && 'bg-accent')}>
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
            <div className="min-w-0 flex-1 basis-64"><RuleSentence rule={rule} id={sentenceId} /></div>
            <Req ids={['R14.9', 'R11.1']}>
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {/* One hit area: the word and the switch (D b19 M395). The switch is named by its rule; the word shows
                    its state, which the switch already says to a screen reader. */}
                <Label className="gap-2 text-xs">
                  <span aria-hidden="true"><RuleStatusBadge rule={rule} justApproved={justApproved} /></span>
                  <Switch aria-labelledby={sentenceId} checked={!off} onCheckedChange={(next) => actions.onToggle(rule, next)} disabled={actions.saving} />
                </Label>
                <Button variant="outline" size="icon-sm" aria-label={t("Edit rule")} onClick={() => actions.onEdit(rule)} disabled={actions.saving}><PencilIcon /></Button>
              </div>
            </Req>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[3.5rem] text-xs text-muted-foreground max-sm:pl-0">
            <Strength rule={rule} />
            <span>{setByText(rule)}</span>
            {replaces.length > 0 && (
              <Req ids={['R14.4']}>
                <Button variant="link" size="xs" className="h-auto px-0 text-xs" onClick={() => actions.onJump(replaces[0].id)}>
                  <RefreshCcwIcon className="size-3.5" />{interpolate(t(replaces.length === 1 ? 'Replaced {count} earlier rule' : 'Replaced {count} earlier rules'), { count: replaces.length })}
                </Button>
              </Req>
            )}
            <CollapsibleTrigger asChild>
              <Button variant="outline" size="sm" className="group/why ml-auto text-xs">{t("Why")}<ChevronDownIcon className="motion-safe:transition-transform group-data-[state=open]/why:rotate-180" /></Button>
            </CollapsibleTrigger>
          </div>

          {toggled && (
            <div data-slot="rule-toggle-result" className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-control-edge/55 bg-surface px-3 py-1.5 text-xs sm:ml-[3.5rem]">
              <p className="min-w-0 flex-1">{toggled.on ? t('Turned on. Agents load it again from their next session.') : t('Turned off. Agents stop loading it from their next session.')}</p>
              <Button variant="outline" size="sm" onClick={toggled.onUndo} disabled={!toggled.canUndo}><Undo2Icon />{t('Undo')}</Button>
            </div>
          )}
          <RuleEvidenceNotice rule={rule} />
          <CollapsibleContent className="mt-2 space-y-3 border-t pt-3 sm:ml-[3.5rem]">
            <RuleEvidence rule={rule} />
            {replaces.length > 0 && (
              <Req ids={['R14.4']}>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{t("Earlier versions it replaced")}</p>
                  {replaces.map((earlier) => (
                    <Button key={earlier.id} variant="bare" onClick={() => actions.onJump(earlier.id)} className="block min-h-6 w-full text-xs text-muted-foreground hover-enabled:text-foreground">
                      {lowerFirst(earlier.then)} · {interpolate(t('until {time}'), { time: displayTime(earlier.replacedBy!.at) })}
                    </Button>
                  ))}
                </div>
              </Req>
            )}
            <SourceRecords rule={rule} />
            <p className="text-xs text-muted-foreground">{sourceText(rule)}</p>
          </CollapsibleContent>
        </article>
      </Collapsible>
    </Req>
  )
}

/**
 * A replaced rule stays visible at full contrast (c-rules-replaced-row): a "Replaced" pill and date carry the state
 * (no strike-through, no dimming), the old rule reads as it was, and the rule now in force sits on its own line.
 */
function ReplacedRow({ rule, replacement, onJump }: { rule: OwnerRule; replacement: OwnerRule | undefined; onJump: (ruleId: string) => void }) {
  return (
    <Req ids={['R14.4', 'R14.7']}>
      <div id={`rule-${rule.id}`} data-slot="replaced-rule" className="space-y-2 px-4 py-3">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-control-edge px-2.5 py-0.5 font-medium text-foreground">
            <RefreshCcwIcon aria-hidden="true" className="size-3.5" />{t(RULE_STATUS_WORDS.replaced)}
          </span>
          <span className="mono-number text-muted-foreground">{displayTime(rule.replacedBy!.at)}</span>
        </p>
        <RuleSentence rule={rule} />
        {replacement && (
          <div className="flex items-start gap-2 text-sm">
            <span className="inline-flex shrink-0 items-center gap-1 pt-px text-xs font-semibold text-shipped-foreground uppercase"><ArrowDownIcon aria-hidden="true" className="size-3.5" />{t('Now')}</span>
            <Button variant="link" className="h-auto min-w-0 shrink justify-start px-0 py-0 text-left text-sm font-medium whitespace-normal text-foreground" onClick={() => onJump(replacement.id)}>{replacement.then}</Button>
          </div>
        )}
      </div>
    </Req>
  )
}

/**
 * Inside a scope, a suggestion is only a pointer: the full rule and the decision live once, in the queue at the top.
 * The Button's own small size and touch rule give it its height (plan rule 6), not a page class.
 */
function SuggestedPointer({ waiting, onReview }: { waiting: OwnerRule[]; onReview: (ruleId: string) => void }) {
  return (
    <Req ids={['R14.2']}>
      <Button variant="ghost" size="sm" onClick={() => onReview(waiting[0].id)} className="-ml-3 text-sm font-medium text-review-foreground">
        <ArrowUpIcon className="size-4" />{interpolate(t('{count} suggested · review above'), { count: waiting.length })}
      </Button>
    </Req>
  )
}

/**
 * The scope's rejected rules, rejected on this visit or an earlier one (they were counted and never listed): each in
 * full under one fold row with the count, with Undo, which puts it back in Needs your decision.
 */
function RejectedRules({ rules, saving, savingReasonId, onUndo }: { rules: OwnerRule[]; saving: boolean; savingReasonId: string; onUndo: (rule: OwnerRule) => void }) {
  return (
    <Collapsible data-slot="rejected-rules">
      <CollapsibleFoldTrigger count={rules.length}>{t('Rejected rules')}</CollapsibleFoldTrigger>
      <CollapsibleContent>
        <ul className="mt-2 divide-y rounded-xl border border-control-edge/55">
          {rules.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
              <div className="min-w-0 flex-1 basis-56"><RuleSentence rule={rule} /></div>
              <Button variant="outline" size="sm" onClick={() => onUndo(rule)} aria-disabled={saving || undefined} aria-describedby={saving ? savingReasonId : undefined}><Undo2Icon />{t('Undo')}</Button>
            </li>
          ))}
        </ul>
        {saving && <p id={savingReasonId} className="mt-1.5 text-xs text-muted-foreground">{t('Saving your last change. Undo works again once it’s saved.')}</p>}
      </CollapsibleContent>
    </Collapsible>
  )
}

// ---------- Needs a decision ----------

type Decision = RuleDecision

/**
 * The current waiting rule in full (c-rules-suggestion-card): the rule's sentence, then its evidence, then Approve (the
 * page's one orange button), "Edit first" outlined and Reject at the far end, and one line saying what each does. On
 * phones the buttons stick above the bottom bar inside the part below the sentence, so they never cover it. While a
 * save is under way the buttons wait, with a line saying for what (G16).
 */
function SuggestionCard({ rule, position, total, saving, onDecide, onEdit, onStep }: {
  rule: OwnerRule; position: number; total: number; saving: boolean
  onDecide: (decision: Decision) => void; onEdit: () => void; onStep: ((step: 1 | -1) => void) | null
}) {
  const scope = useRuleScope(rule.scopeId)
  const savingReasonId = useId()
  const [first, ...more] = rule.quotes
  const waits = saving ? { 'aria-disabled': true, 'aria-describedby': savingReasonId } as const : {}
  return (
    <Req ids={['R14.2', 'R14.3', 'R14.8', 'R14.9']}>
      <Confirmation id={`decide-${rule.id}`} approval={{ id: rule.id }} state="approval-requested"
        className="gap-2.5 border-control-edge p-4 shadow-panel">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="xs" className="rounded-full" onClick={() => scrollToId(`scope-${scope.id}`)}>{displayScope(scope)}</Button>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="mono-number text-xs text-muted-foreground">{interpolate(t('{position} of {total}'), { position, total })}</span>
            {onStep && <>
              <Button variant="outline" size="icon-sm" data-step="previous" aria-label={t('Previous rule')} onClick={() => onStep(-1)}><ChevronLeftIcon /></Button>
              <Button variant="outline" size="icon-sm" data-step="next" aria-label={t('Next rule')} onClick={() => onStep(1)}><ChevronRightIcon /></Button>
            </>}
          </span>
        </div>

        <RuleSentence rule={rule} large />
        <div className={DECISION_CARD_BODY}>
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><Strength rule={rule} /><span>{interpolate(t('learned by {source}'), { source: rule.source })}</span></p>
          <RuleEvidenceNotice rule={rule} />
          {first && <Quote quote={first} rule={rule} />}
          {more.length > 0 && <MoreQuotesFold count={more.length}>{more.map((quote) => <Quote key={quote.quote} quote={quote} rule={rule} />)}</MoreQuotesFold>}

          <ConfirmationRequest>
            <Req ids={['R11.1']}>
              {/* Below the md width the buttons stick just above the pinned bottom bar while the card is on screen, so
                  the bar never covers Approve or Reject (page-07 F7, D9; STICKY_ABOVE_BOTTOM_BAR). */}
              <ConfirmationActions className={cn('w-full flex-wrap justify-start self-stretch border-t pt-3', STICKY_ABOVE_BOTTOM_BAR)}>
                {/* 12px sides on phones keep the three on one 44px row at 390px (326px between the card's edges). */}
                <ConfirmationAction className="max-sm:px-3" onClick={() => onDecide('approved')} {...waits}><CheckIcon />{t("Approve")}</ConfirmationAction>
                <ConfirmationAction variant="outline" className="max-sm:px-3" onClick={onEdit} {...waits}><PencilIcon />{t("Edit first")}</ConfirmationAction>
                <ConfirmationAction variant="ghost" className="ml-auto max-sm:px-3" onClick={() => onDecide('rejected')} {...waits}><XIcon />{t("Reject")}</ConfirmationAction>
                {saving && <p id={savingReasonId} data-slot="decision-waits-for" className="basis-full text-xs text-muted-foreground">{t('Saving your last change. These buttons work again once it’s saved.')}</p>}
              </ConfirmationActions>
            </Req>
            <p className="text-xs text-muted-foreground">{t('Approve adds it to MY-RULES.md. Reject stops it being suggested. Both can be undone.')}</p>
          </ConfirmationRequest>
        </div>
      </Confirmation>
    </Req>
  )
}

/** Where focus can land in the queue after a press (quality M5): the element that has it draws the focus ring. */
const QUEUE_FOCUS_TARGET = 'rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50'

/**
 * A decided rule, shrunk at once to its result (c-ai-confirmation M1, M4): an icon and an edge colour as well as words,
 * the whole rule it is about (never cut: a rejected rule shows nowhere else), and Show it / Undo as 44px outlined
 * buttons. No timer and no sparks. It takes focus when the last waiting rule is decided (quality M5).
 */
function DecisionResult({ rule, decision, saving, savingReasonId, focusTarget, onUndo, onShow }: {
  rule: OwnerRule; decision: Decision; saving: boolean; savingReasonId: string; focusTarget: boolean; onUndo: () => void; onShow: () => void
}) {
  const scope = useRuleScope(rule.scopeId)
  const { icon: Mark, iconClass, edge } = RULE_DECISION_MARK[decision]
  return (
    <Confirmation approval={{ id: rule.id, approved: decision === 'approved' }} state="approval-responded" data-slot="decision-result" data-decision={decision}
      tabIndex={-1} data-queue-focus={focusTarget || undefined}
      className={cn('flex-row flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5', edge, QUEUE_FOCUS_TARGET)}>
      <Mark aria-hidden="true" className={cn('size-5 shrink-0', iconClass)} />
      <div className="min-w-0 flex-1 basis-48">
        <ConfirmationAccepted>
          <ConfirmationTitle className="block text-sm font-medium text-shipped-foreground">{interpolate(t('Approved. It’s now under {scope} and in MY-RULES.md.'), { scope: displayScope(scope) })}</ConfirmationTitle>
        </ConfirmationAccepted>
        <ConfirmationRejected>
          <ConfirmationTitle className="block text-sm font-medium text-foreground">{t("Rejected. It won’t be suggested again unless you say it again.")}</ConfirmationTitle>
        </ConfirmationRejected>
        <p data-slot="decided-rule" className="text-xs [overflow-wrap:anywhere] text-muted-foreground">{ruleLine(rule)}</p>
      </div>
      <div className="flex gap-2">
        {decision === 'approved' && <Button variant="outline" onClick={onShow}><ArrowDownIcon />{t("Show it")}</Button>}
        <Button variant="outline" onClick={onUndo} aria-disabled={saving || undefined} aria-describedby={saving ? savingReasonId : undefined}><Undo2Icon />{t("Undo")}</Button>
      </div>
    </Confirmation>
  )
}

/** One waiting rule as a row: its strength, the rule on one line and how often it was said; pressing it makes it current. */
function QueueRow({ rule, onOpen }: { rule: OwnerRule; onOpen: () => void }) {
  const strength = strengthOf(rule)
  return (
    <Button variant="bare" onClick={onOpen} data-slot="queue-row" data-rule-id={rule.id}
      className="flex min-h-9 w-full items-center gap-3 rounded-md px-2 py-1 text-sm hover-enabled:bg-surface">
      <span className={cn('flex', strength === 'strong' ? 'text-foreground' : 'text-muted-foreground')}><StrengthBars rule={rule} /></span>
      <span className="min-w-0 flex-1 truncate">{ruleLine(rule)}</span>
      <span aria-hidden="true" className="mono-number shrink-0 text-xs text-muted-foreground">{interpolate(t('{count}×'), { count: rule.timesSeen })}</span>
      <span className="sr-only">{interpolate(t(rule.timesSeen === 1 ? '{strength}, said {count} time' : '{strength}, said {count} times'), { strength: t(RULE_STRENGTH_WORDS[strength]), count: rule.timesSeen })}</span>
    </Button>
  )
}

// The rows "Up next" shows under the current rule: three, as the page mockup draws, so the owner's own rules still
// start on the first screen at 1440×900 (page-07 M4).
const UP_NEXT_ROWS = 3

/** Where focus goes once the queue has redrawn after a press (quality M5): its focus target, or a step button. */
type QueueFocus = 'target' | 'next' | 'previous'

/**
 * The queue's one focus target (`data-queue-focus`): the current card, else the last decision's result, else the
 * heading, so focus never falls to the page body. Each draws the focus ring.
 */
const focusQueueTarget = (section: HTMLElement | null) => section?.querySelector<HTMLElement>('[data-queue-focus]')?.focus()

/** Phones: a row that scrolls sideways shows a fade at each edge with more chips past it (the scrollbar is hidden). */
function useScrollCue(row: RefObject<HTMLElement | null>) {
  const [more, setMore] = useState<{ before: boolean; after: boolean }>({ before: false, after: false })
  useEffect(() => {
    const element = row.current
    if (!element) return
    const measure = () => {
      // 1px of slack: a fractional width can leave the last pixel of a fully scrolled row unscrolled.
      const before = element.scrollLeft > 1
      const after = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
      setMore((shown) => shown.before === before && shown.after === after ? shown : { before, after })
    }
    measure()
    element.addEventListener('scroll', measure, { passive: true })
    const resized = new ResizeObserver(measure)
    resized.observe(element)
    return () => { element.removeEventListener('scroll', measure); resized.disconnect() }
  }, [row])
  return more
}

/** The fade a scroll cue draws, as a mask on the row itself, so it stays at the row's edge while the chips move. */
const SCROLL_CUE_MASK = {
  after: '[mask-image:linear-gradient(to_right,#000_calc(100%_-_2.5rem),transparent)]',
  before: '[mask-image:linear-gradient(to_left,#000_calc(100%_-_2.5rem),transparent)]',
  both: '[mask-image:linear-gradient(to_right,transparent,#000_2.5rem,#000_calc(100%_-_2.5rem),transparent)]',
} as const
const scrollCueMask = ({ before, after }: { before: boolean; after: boolean }) =>
  before && after ? SCROLL_CUE_MASK.both : after ? SCROLL_CUE_MASK.after : before ? SCROLL_CUE_MASK.before : undefined

/**
 * The queue of learned rules (c-rules-decision-queue): a thin decided-of-total line, strength chips with real counts,
 * the one current rule in full, the last decision's result, then "Up next" rows and "Show all N". The card stays on the
 * rule the person is reading, held by its id, until they decide it or move on themselves (quality M1).
 */
function DecisionQueue({ suggestions, decisions, lastDecidedId, saving, pointer, onPoint, onDecide, onEdit, onUndo, onShow }: {
  suggestions: OwnerRule[]; decisions: Record<string, Decision>; lastDecidedId: string | null; saving: boolean
  pointer: string | null; onPoint: (ruleId: string | null) => void
  onDecide: (rule: OwnerRule, decision: Decision) => Promise<boolean>; onEdit: (rule: OwnerRule) => void
  onUndo: (rule: OwnerRule) => Promise<boolean>; onShow: (rule: OwnerRule) => void
}) {
  const isPhone = useIsPhone()
  const savingReasonId = useId()
  const [filter, setFilter] = useState<StrengthFilter>('all')
  const [showAll, setShowAll] = useState(false)
  const [shownRows, setShownRows] = useState(LIST_ROWS_PER_PAGE)
  const sectionRef = useRef<HTMLElement>(null)
  const chipsRef = useRef<HTMLDivElement>(null)
  const chipsCue = useScrollCue(chipsRef)
  // The order the person first saw, kept across live updates; rules new to the queue join after the last card shown
  // (live/rule-queue.ts). Both are adjusted while drawing, React's pattern for state that follows a prop: keepShownOrder
  // returns the same order when nothing is new, so this settles in one extra pass at most.
  const [shownOrder, setShownOrder] = useState<readonly string[]>([])
  const [lastShownId, setLastShownId] = useState<string | null>(null)
  const order = keepShownOrder(shownOrder, suggestions, lastShownId)
  if (order !== shownOrder) setShownOrder(order)
  const shown = inShownOrder(order, suggestions)
  const total = suggestions.length
  const decided = suggestions.filter((rule) => decisions[rule.id]).length
  // Of the whole queue, so the chips stay put while deciding (implementer's decision 5).
  const strengthCounts: Record<StrengthFilter, number> = { all: total, strong: 0, steady: 0, light: 0 }
  for (const rule of suggestions) strengthCounts[strengthOf(rule)]++
  const list = filter === 'all' ? shown : shown.filter((rule) => strengthOf(rule) === filter)
  const current = currentIn(order, list, decisions, pointer)
  const currentId = current?.id ?? null
  if (currentId !== null && currentId !== lastShownId) setLastShownId(currentId)
  const lastDecided = lastDecidedId ? list.find((rule) => rule.id === lastDecidedId && decisions[rule.id]) : undefined
  const upNext = upNextAfter(list, decisions, current, UP_NEXT_ROWS)
  const waitingInList = list.filter((rule) => !decisions[rule.id]).length
  // "Show all N" (N: the total, decision C1) whenever rows are left out of the current card and Up next.
  const canShowAll = showAll || list.length > upNext.length + (current ? 1 : 0)

  // Focus after a press moves once the queue has redrawn (quality M5), and the card's rule becomes the pointer, so a
  // later live update cannot swap it. A failed save asks for nothing: focus stays on the button that was pressed. The
  // request waits in a ref; the counter wakes the effect after the redraw it asked for.
  const focusAsked = useRef<QueueFocus | null>(null)
  const [focusRequests, setFocusRequests] = useState(0)
  const askFocus = (to: QueueFocus) => { focusAsked.current = to; setFocusRequests((count) => count + 1) }
  useEffect(() => {
    const to = focusAsked.current
    if (to === null) return
    focusAsked.current = null
    if (currentId !== null && currentId !== pointer) onPoint(currentId)
    const section = sectionRef.current
    const stepButton = to === 'target' ? null : section?.querySelector<HTMLElement>(`[data-queue-focus] [data-step=${to}]`)
    if (stepButton) stepButton.focus()
    else focusQueueTarget(section)
  }, [focusRequests, currentId, pointer, onPoint])
  // A live update that redraws the card while focus was in it puts focus on the queue's target, not the page body.
  const focusWasInQueue = useRef(false)
  useEffect(() => {
    if (focusWasInQueue.current && document.activeElement === document.body) focusQueueTarget(sectionRef.current)
  }, [currentId, lastDecided?.id])

  const point = (ruleId: string, to: QueueFocus = 'target') => { onPoint(ruleId); askFocus(to) }
  const decide = async (rule: OwnerRule, decision: Decision) => {
    onPoint(rule.id)
    if (await onDecide(rule, decision)) askFocus('target')
  }
  // The undone rule is the card again once the undo is saved (not before: the card would jump while it saves).
  const undo = async (rule: OwnerRule) => {
    if (!(await onUndo(rule))) return
    onPoint(rule.id)
    askFocus('target')
  }
  const step = current && waitingInList > 1
    ? (direction: 1 | -1) => { const next = stepFrom(list, decisions, current, direction); if (next) point(next.id, direction === 1 ? 'next' : 'previous') }
    : null
  // Keyed by rule: a new rule's card opens with its folds closed (quality L5).
  const card = current && (
    <SuggestionCard key={current.id} rule={current} position={list.indexOf(current) + 1} total={list.length} saving={saving}
      onDecide={(decision) => void decide(current, decision)} onEdit={() => onEdit(current)} onStep={step} />
  )
  const swipeHint = isPhone && current && <SwipeHint>{t('Swipe right to approve, left to reject. Or use the buttons.')}</SwipeHint>
  return (
    <Req ids={['R14.2', 'R12.3', 'R12.2']}>
      <section ref={sectionRef} id="decide" aria-labelledby="decide-heading" className="space-y-3"
        onFocus={() => { focusWasInQueue.current = true }}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) focusWasInQueue.current = false }}>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 id="decide-heading" tabIndex={-1} data-queue-focus={!current && !lastDecided ? true : undefined} className={cn('text-base font-semibold', QUEUE_FOCUS_TARGET, 'rounded-sm')}>{t("Needs your decision")}</h2>
            {decided < total && <StateBadge state="your-move" />}
            {total > 0 && (
              // Phones: one row that scrolls sideways, so the current rule starts higher on the first screen; a fade at
              // either edge shows that more chips are past it.
              <div ref={chipsRef} className={cn('max-sm:-mx-1 max-sm:w-[calc(100%+0.5rem)] max-sm:overflow-x-auto max-sm:p-1 max-sm:[scrollbar-width:none] sm:ml-auto', scrollCueMask(chipsCue))}
                data-slot="strength-chips" data-more-before={chipsCue.before || undefined} data-more-after={chipsCue.after || undefined}>
                <ToggleGroup type="single" variant="outline" size="sm" spacing={1} className="flex-wrap max-sm:w-max max-sm:flex-nowrap" aria-label={t('Strength')} value={filter}
                  onValueChange={(value) => { if (isStrengthFilter(value)) { setFilter(value); onPoint(null); setShownRows(LIST_ROWS_PER_PAGE) } }}>
                  {STRENGTH_FILTERS.map((strength) => <ToggleGroupItem key={strength} value={strength}>{t(STRENGTH_FILTER_WORDS[strength])} <span className="tabular">{strengthCounts[strength]}</span></ToggleGroupItem>)}
                </ToggleGroup>
              </div>
            )}
          </div>
          {/* The thin decided-of-total line (c-rules-decision-queue M3), with its words beside it. */}
          {total > 0 && (
            <div className="flex items-center gap-3">
              <Progress value={decided} max={total} className="h-1 flex-1" aria-label={interpolate(t('{decided} of {total} decided'), { decided, total })} />
              <span aria-live="polite" className="shrink-0 text-sm text-muted-foreground tabular">{interpolate(t('{decided} of {total} decided'), { decided, total })}</span>
            </div>
          )}
        </div>
        {total === 0 ? (
          <Req ids={['R12.1']}>
            <p className="text-sm text-muted-foreground">{t("Nothing waiting. New suggestions show up here after the next learning run.")}</p>
          </Req>
        ) : (
          <>
            {lastDecided && <DecisionResult rule={lastDecided} decision={decisions[lastDecided.id]} saving={saving} savingReasonId={savingReasonId} focusTarget={!current}
              onUndo={() => void undo(lastDecided)} onShow={() => onShow(lastDecided)} />}
            {current ? (
              <div className="space-y-2">
                <div tabIndex={-1} data-queue-focus className={QUEUE_FOCUS_TARGET}>
                  {isPhone ? (
                    <SwipeToDecide key={current.id} disabled={saving}
                      right={{ word: t('Approve'), swipeFurther: t('Swipe further to approve'), letGo: t('Let go to approve'), icon: CheckIcon, onDecide: () => void decide(current, 'approved') }}
                      left={{ word: t('Reject'), swipeFurther: t('Swipe further to reject'), letGo: t('Let go to reject'), icon: XIcon, onDecide: () => void decide(current, 'rejected') }}>
                      {card}
                    </SwipeToDecide>
                  ) : card}
                </div>
                {/* Under the card on phones, so the rule's sentence starts higher on the first screen (Phase 7 verify). */}
                {swipeHint}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{filter === 'all' ? t('You decided every rule here. Undo any of them below.') : t('Nothing waiting at this strength.')}</p>
            )}

            {(upNext.length > 0 || canShowAll) && (
              <div className="flex flex-wrap items-center justify-between gap-x-3">
                <p className="section-label">{showAll ? interpolate(t('All waiting rules · {count}'), { count: list.length }) : interpolate(t('Up next · {count}'), { count: Math.max(0, waitingInList - 1) })}</p>
                {canShowAll && (
                  <Button variant="link" size="xs" className="px-0" aria-expanded={showAll} onClick={() => { setShowAll((open) => !open); setShownRows(LIST_ROWS_PER_PAGE) }}>
                    {showAll ? t('Show fewer') : interpolate(t('Show all {count}'), { count: list.length })}
                  </Button>
                )}
              </div>
            )}
            {!showAll && upNext.length > 0 && <ul className="divide-y border-y">{upNext.map((rule) => <li key={rule.id}><QueueRow rule={rule} onOpen={() => point(rule.id)} /></li>)}</ul>}
            {showAll && (
              <div>
                <ul className="divide-y border-y">
                  {list.slice(0, shownRows).map((rule) => {
                    const decision = decisions[rule.id]
                    const DecidedMark = decision ? RULE_DECISION_MARK[decision].icon : null
                    return (
                      <li key={rule.id}>
                        {rule === current ? (
                          <p aria-current="true" className="flex min-h-10 items-center gap-3 px-2 py-1.5 text-sm font-medium">
                            <span className="text-foreground"><StrengthBars rule={rule} /></span>
                            <span className="min-w-0 flex-1 truncate">{ruleLine(rule)}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">{t('Shown above')}</span>
                          </p>
                        ) : decision && DecidedMark ? (
                          <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 text-sm">
                            <DecidedMark aria-hidden="true" className={cn('size-4 shrink-0', RULE_DECISION_MARK[decision].iconClass)} />
                            {/* The whole rule: a rejected one is shown nowhere else (anti-pattern L4). */}
                            <span data-slot="decided-rule" className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere] text-muted-foreground">{ruleLine(rule)}</span>
                            <span className="shrink-0 text-xs">{t(RULE_DECISION_WORDS[decision])}</span>
                            <Button variant="outline" size="sm" onClick={() => void undo(rule)} aria-disabled={saving || undefined} aria-describedby={saving ? savingReasonId : undefined}><Undo2Icon />{t('Undo')}</Button>
                          </div>
                        ) : <QueueRow rule={rule} onOpen={() => point(rule.id)} />}
                      </li>
                    )
                  })}
                </ul>
                {/* G4: 50 rows at a time, with how many are shown and how many are left (the shared footer). */}
                {list.length > LIST_ROWS_PER_PAGE && <TablePageFooter shownCount={Math.min(shownRows, list.length)} totalCount={list.length} onShowMore={() => setShownRows((rows) => rows + LIST_ROWS_PER_PAGE)} />}
              </div>
            )}
            {saving && (lastDecided || showAll) && <p id={savingReasonId} className="text-xs text-muted-foreground">{t('Saving your last change. Undo works again once it’s saved.')}</p>}
          </>
        )}
      </section>
    </Req>
  )
}

// ---------- Scope sections ----------

function GroupLabel({ children }: { children: ReactNode }) {
  return <p className="section-label">{children}</p>
}

interface ScopeCounts { on: number; off: number; suggested: number; replaced: number }

/** One scope: Your rules (set or approved, by strength), a pointer to its suggestions, then the replaced chain (§14). */
function ScopeSection({ scope, rules, counts, approvedNow, highlighted, toggled, actions, onReview }: { scope: RuleScope; rules: OwnerRule[]; counts: ScopeCounts; approvedNow: Set<string>; highlighted: string | null; toggled: ToggleResult | null; actions: RuleActions; onReview: (ruleId: string) => void }) {
  const rejectedSavingReasonId = useId()
  const yours = rules.filter((rule) => rule.status === 'on' || rule.status === 'off').sort((a, b) => Number(a.status === 'off') - Number(b.status === 'off') || byStrength(a, b))
  const waiting = rules.filter((rule) => rule.status === 'suggested').sort(byStrength)
  const rejected = rules.filter((rule) => rule.status === 'dismissed').sort(byStrength)
  const replaced = rules.filter((rule) => rule.status === 'replaced').sort((a, b) => a.latestDaysAgo - b.latestDaysAgo)
  const tierLabel = RULE_TIERS.find((tier) => tier.tier === scope.tier)!.label
  return (
    <Req ids={['R14.5', 'R14.6', 'R14.7']}>
      <section id={`scope-${scope.id}`} className="space-y-3">
        <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="flex flex-wrap items-baseline gap-x-3">
            {scope.tier !== 'everywhere' && <p className="basis-full text-xs text-muted-foreground">{t(tierLabel)}</p>}
            <h2 className="text-base font-semibold">{displayScope(scope)}</h2>
            {yours.length > 0 && <GroupLabel>{t("Your rules · strongest first")}</GroupLabel>}
          </div>
          <p className="text-xs text-muted-foreground tabular">{interpolate(t('{count} on'), { count: counts.on })}{counts.off ? interpolate(t(' · {count} off'), { count: counts.off }) : ''}{counts.suggested ? interpolate(t(' · {count} suggested'), { count: counts.suggested }) : ''}</p>
        </header>

        {yours.length > 0 && (
          <div className="space-y-2">
            <div className="divide-y rounded-xl border border-control-edge/55 shadow-panel">
              {yours.map((rule) => <RuleBlock key={rule.id} rule={rule} replaces={rules.filter((other) => other.status === 'replaced' && chainReaches(rules, other, rule.id))} justApproved={approvedNow.has(rule.id)} highlighted={highlighted === rule.id} toggled={toggled?.ruleId === rule.id ? toggled : null} actions={actions} />)}
            </div>
          </div>
        )}
        {waiting.length > 0 && (
          <div>
            <GroupLabel>{t("Suggested · learned, not yours until you approve")}</GroupLabel>
            <SuggestedPointer waiting={waiting} onReview={onReview} />
          </div>
        )}
        {rejected.length > 0 && <RejectedRules rules={rejected} saving={actions.saving} savingReasonId={rejectedSavingReasonId} onUndo={actions.onRestore} />}
        {replaced.length > 0 && (
          <div className="space-y-2">
            <GroupLabel>{t("Replaced · when rules conflict, the newer one wins")}</GroupLabel>
            <div className="divide-y rounded-xl border border-control-edge/55">
              {replaced.map((rule) => <ReplacedRow key={rule.id} rule={rule} replacement={rules.find((other) => other.id === rule.replacedBy!.ruleId)} onJump={actions.onJump} />)}
            </div>
          </div>
        )}
      </section>
    </Req>
  )
}

/** True when `rule` was replaced, directly or through a chain, by `targetId`. */
function chainReaches(rules: OwnerRule[], rule: OwnerRule, targetId: string): boolean {
  if (!rule.replacedBy) return false
  if (rule.replacedBy.ruleId === targetId) return true
  const next = rules.find((other) => other.id === rule.replacedBy!.ruleId)
  return next ? chainReaches(rules, next, targetId) : false
}

// ---------- Side rail: jump between scopes, the file agents load, where edits go, the last learning run ----------

// The band a section must reach to count as the one on screen: below the floating header (about 80px) and in the
// upper 45% of the window, so the row changes as a section's heading passes the top of the reading area.
const CURRENT_SECTION_BAND = '-90px 0px -55% 0px'

/**
 * Which of `ids` is on screen now, for the side list's current row (c-rules-scope-nav M1). A scope's id is its saved id,
 * which can hold spaces (`situation:When I’m frustrated`), so the list is compared as JSON, never split on spaces.
 */
function useSectionOnScreen(ids: string[]) {
  const [onScreen, setOnScreen] = useState<string | null>(ids[0] ?? null)
  const key = JSON.stringify(ids)
  useEffect(() => {
    const sectionIds: string[] = JSON.parse(key)
    const elements = sectionIds.map((id) => document.getElementById(id)).filter((element): element is HTMLElement => element !== null)
    if (elements.length === 0) return
    const inBand = new Map<string, boolean>()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) inBand.set(entry.target.id, entry.isIntersecting)
      const first = sectionIds.find((id) => inBand.get(id))
      if (first) setOnScreen(first)
    }, { rootMargin: CURRENT_SECTION_BAND })
    for (const element of elements) observer.observe(element)
    return () => observer.disconnect()
  }, [key])
  return [onScreen, setOnScreen] as const
}

// The rows are the Button's ghost variant at its default 44px size (c-rules-scope-nav M3): the primitive owns the height.
const NAV_ROW = 'relative w-full justify-between rounded-lg px-3 text-left font-normal aria-[current=location]:bg-surface aria-[current=location]:font-medium aria-[current=location]:before:absolute aria-[current=location]:before:inset-y-2 aria-[current=location]:before:left-0 aria-[current=location]:before:w-[3px] aria-[current=location]:before:rounded-full aria-[current=location]:before:bg-ring'

/** The side list (lg): the section on screen has a raised row, an edge bar and aria-current; every count has its word. */
function ScopeNav({ countsByScope, waiting }: { countsByScope: Map<string, ScopeCounts>; waiting: number }) {
  const { ruleScopes } = useWorkModel()
  const ids = ['decide', ...ruleScopes.map((scope) => `scope-${scope.id}`)]
  const [onScreen, setOnScreen] = useSectionOnScreen(ids)
  const jump = (id: string) => { setOnScreen(id); scrollToId(id) }
  return (
    <Req ids={['R14.5']}>
      {/* Never taller than the window below its sticky offset (top-20, 5rem, plus 1.25rem of air), so with any number
          of scopes the last row stays reachable while the list is stuck: a longer list scrolls inside itself. */}
      <nav className="max-h-[calc(100dvh_-_6.25rem)] space-y-1 overflow-y-auto rounded-xl border border-control-edge/55 bg-card p-2 text-sm shadow-panel" aria-label={t("Scopes")}>
        <p className="section-label px-2 pt-1">{t('On this page')}</p>
        <Button variant="ghost" onClick={() => jump('decide')} aria-current={onScreen === 'decide' ? 'location' : undefined} className={cn(NAV_ROW, 'flex')}>
          <span>{t("Needs your decision")}</span>
          {waiting > 0 && <span className="rounded-full bg-attention px-2 text-xs font-medium text-attention-foreground tabular">{waiting}</span>}
        </Button>
        <p className="section-label px-2 pt-2">{t('Your rules')}</p>
        {RULE_TIERS.filter(({ tier }) => ruleScopes.some((scope) => scope.tier === tier)).map(({ tier, label }) => (
          <div key={tier} className="space-y-0.5">
            {tier !== 'everywhere' && <p className="px-3 text-xs text-muted-foreground">{t(label)}</p>}
            {ruleScopes.filter((scope) => scope.tier === tier).map((scope) => {
              const id = `scope-${scope.id}`
              return (
                <Button key={scope.id} variant="ghost" onClick={() => jump(id)} aria-current={onScreen === id ? 'location' : undefined} className={cn(NAV_ROW, 'flex')}>
                  <span className="min-w-0 truncate">{scope.tier === 'everywhere' ? t('Everywhere') : scope.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular">{interpolate(t('{count} on'), { count: countsByScope.get(scope.id)!.on })}</span>
                </Button>
              )
            })}
          </div>
        ))}
      </nav>
    </Req>
  )
}

/**
 * Mobile: the same jump list as a sticky, thumb-sized chip row under the app header (§11). The row scrolls sideways
 * with its scrollbar hidden, so a fade at either edge shows that more chips are past it.
 */
function ScopeChips({ countsByScope, waiting }: { countsByScope: Map<string, ScopeCounts>; waiting: number }) {
  const { ruleScopes } = useWorkModel()
  const rowRef = useRef<HTMLDivElement>(null)
  const cue = useScrollCue(rowRef)
  return (
    <Req ids={['R14.5', 'R11.1']} className="lg:hidden">
      {/* top-[76px]: just under the floating header pill (20px drop + 56px tall). */}
      <nav aria-label={t("Scopes")} data-slot="rule-scope-chips" className="sticky top-[76px] z-20 -mx-4 border-b bg-background/95 py-2 backdrop-blur lg:hidden">
        <div ref={rowRef} className={cn('flex gap-2 overflow-x-auto px-4 [scrollbar-width:none]', scrollCueMask(cue))} data-more-before={cue.before || undefined} data-more-after={cue.after || undefined}>
        {waiting > 0 && (
          <Button variant="outline" className="shrink-0 rounded-full border-attention-border text-attention-foreground" onClick={() => scrollToId('decide')}>
            <span aria-hidden="true" className="size-1.5 rounded-full bg-attention-foreground" />{interpolate(t('Decide · {count}'), { count: waiting })}
          </Button>
        )}
        {ruleScopes.map((scope) => (
          <Button key={scope.id} variant="outline" className="shrink-0 rounded-full font-normal" onClick={() => scrollToId(`scope-${scope.id}`)}>
            {scope.tier === 'everywhere' ? t('Everywhere') : scope.name}<span className="text-muted-foreground tabular">{interpolate(t('· {count} on'), { count: countsByScope.get(scope.id)!.on })}</span>
          </Button>
        ))}
        </div>
      </nav>
    </Req>
  )
}

const SET_BY_ORDER: Record<OwnerRule['setBy'], number> = { owner: 0, approved: 1, learned: 2 }

/** The rules file as claude-mem writes it (my-rules.mjs renderRulesFile): approved rules that are on, by scope, set by you first, then strength. */
function rulesFileLines(rules: OwnerRule[], scopes: RuleScope[]) {
  const loaded = rules.filter((rule) => rule.status === 'on' && (rule.setBy === 'owner' || rule.setBy === 'approved'))
  // The file is agent input, not UI chrome: keep its headings and whitespace verbatim.
  const ordered = [...scopes].sort((a, b) => RULE_TIERS.findIndex(({ tier }) => tier === a.tier) - RULE_TIERS.findIndex(({ tier }) => tier === b.tier) || a.name.localeCompare(b.name))
  return [
    { text: '# My Rules', ruleId: null as string | null },
    { text: '', ruleId: null },
    { text: 'How I want agents to work. Written by claude-mem from the rules I set or approved in My Rules (localhost:37777).', ruleId: null },
    ...ordered.flatMap((scope) => {
      // The mapped model has only whole-day recency; sub-day ordering needs the original timestamps.
      const inScope = loaded.filter((rule) => rule.scopeId === scope.id).sort((a, b) => SET_BY_ORDER[a.setBy] - SET_BY_ORDER[b.setBy] || byStrength(a, b))
      return inScope.length ? [{ text: '', ruleId: null }, { text: `## ${scopeHeading(scope)}`, ruleId: null }, { text: '', ruleId: null }, ...inScope.map((rule) => ({ text: rule.when ? `- When ${rule.when}: ${lowerFirst(rule.then)}` : `- ${rule.then}`, ruleId: rule.id }))] : []
    }),
  ]
}

/** What the last copy did, worded for people. One definition; the buttons and the spoken line read it. */
type CopyOutcome = 'copied' | 'failed'
const COPY_OUTCOME_WORDS: Record<CopyOutcome, string> = { copied: 'Copied', failed: 'Could not copy. Select the text and copy it yourself.' }

/** Copies text to the clipboard and remembers how it went until the next copy (no timer). */
function useCopy() {
  const [outcome, setOutcome] = useState<{ what: string; outcome: CopyOutcome } | null>(null)
  const copy = (what: string, text: string) => {
    navigator.clipboard.writeText(text)
      .then(() => setOutcome({ what, outcome: 'copied' }))
      .catch((error: unknown) => { console.warn('[my-rules] copy failed', error); setOutcome({ what, outcome: 'failed' }) })
  }
  return { copied: (what: string) => outcome?.what === what ? outcome.outcome : null, copy, reset: () => setOutcome(null) }
}

/** "~/.claude-mem/" and "MY-RULES.md": the folder may wrap at its slashes; the file name never breaks (c-ai-artifact F4). */
const splitPath = (path: string) => { const at = path.lastIndexOf('/') + 1; return { folder: path.slice(0, at), file: path.slice(at) } }

/**
 * The Markdown file agents load (decision 7; c-rules-agent-file and c-ai-artifact): a short header strip with the file
 * name, facts in the body, actions in a bottom row. Narrow (the side rail), the folder has its own line; wide (below the
 * lg width, where the rail drops under the rules), the whole path is in the header with the line count beside it.
 * Changes this session are marked in the preview.
 */
function AgentFile({ rules, changed, open, onOpenChange }: { rules: OwnerRule[]; changed: Set<string>; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { mode } = useWorkspace()
  const { sourceKind, ruleScopes, rulesFile } = useWorkModel()
  const [loadError, setLoadError] = useState<string | null>(null)
  const { copied, copy, reset } = useCopy()
  const loaded = rules.filter((rule) => rule.status === 'on' && rule.setBy !== 'learned').length
  const lines = rulesFileLines(rules, ruleScopes)
  const path = rulesFile?.path ?? '~/.claude-mem/MY-RULES.md'
  const { folder, file } = splitPath(path)
  const instructionsPath = rulesFile?.instructionsPath ?? '~/.claude/CLAUDE.md'
  const load = () => { setLoadError(null); useStore.getState().loadRulesInClaudeCode().catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error))) }
  const pathCopied = copied('path')
  const fileCopied = copied('file')
  return (
    <Req ids={['D7']}>
      <Artifact className="@container border-control-edge/55">
        <ArtifactHeader className="gap-3 px-4 py-3">
          <ArtifactTitle className="flex min-w-0 items-center gap-2 font-mono text-sm">
            <FileTextIcon aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0"><span className="hidden [overflow-wrap:anywhere] @md:inline">{folder}</span><span className="whitespace-nowrap">{file}</span></span>
          </ArtifactTitle>
          <span className="mono-number hidden shrink-0 text-xs text-muted-foreground @md:inline">{interpolate(t(lines.length === 1 ? '{count} line' : '{count} lines'), { count: lines.length })}</span>
        </ArtifactHeader>
        <ArtifactContent className="space-y-3 px-4 py-3">
          <p className="font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground @md:hidden">{folder}</p>
          <div className="space-y-1">
            <p className="text-sm font-medium tabular">{interpolate(t(loaded === 1 ? '{count} rule you set or approved' : '{count} rules you set or approved'), { count: loaded })}</p>
            <p className="text-xs text-muted-foreground">{t('claude-mem writes this file and loads it with your user-level instructions, never a project’s files.')}</p>
            {rulesFile?.loadedInClaudeCode && sourceKind !== 'sample' && <p className="text-xs text-muted-foreground">{interpolate(t('Loaded in Claude Code from {path}.'), { path: instructionsPath })}</p>}
          </div>
          <ArtifactActions className="flex-wrap gap-2 @md:justify-end">
            <Button variant="outline" onClick={() => onOpenChange(true)}><EyeIcon />{t("Preview file")}{changed.size > 0 && interpolate(t(' · {count} changed'), { count: changed.size })}</Button>
            {/* Narrow, the copy button is its icon (the mockup's narrow card); its name stays "Copy path". */}
            <Button variant="outline" className="@max-md:px-3" onClick={() => copy('path', path)}>
              {pathCopied === 'copied' ? <CheckIcon /> : <CopyIcon />}
              <span className="@max-md:sr-only">{pathCopied === 'copied' ? t(COPY_OUTCOME_WORDS.copied) : t('Copy path')}</span>
            </Button>
          </ArtifactActions>
          {pathCopied === 'failed' && <p role="alert" className="text-xs text-destructive">{t(COPY_OUTCOME_WORDS.failed)}</p>}
          {rulesFile && !rulesFile.loadedInClaudeCode && sourceKind !== 'cloud' && (
            <div className="space-y-1.5 border-t pt-3">
              <Button variant="outline" onClick={load}>{t("Load my rules into Claude Code")}</Button>
              <p className="text-xs text-muted-foreground">{interpolate(t('Only rules you approved are loaded. Adds one line to {path}.'), { path: instructionsPath })}</p>
              {/* G17: plain words; the raw cause under Details. */}
              {loadError && (
                <div role="alert" data-slot="rules-load-failed" className="space-y-1">
                  <p className="text-xs text-attention-foreground">{t('Your rules were not loaded into Claude Code.')}</p>
                  <ErrorDetails cause={loadError} />
                </div>
              )}
            </div>
          )}
        </ArtifactContent>
      </Artifact>
      <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next) }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-base [overflow-wrap:anywhere]">{path}</DialogTitle>
            <DialogDescription>
              {interpolate(t('Rebuilt from the synced rule records, so every machine gets the same file{mode}. Claude Code imports it from {path}. Suggested rules are not in it until you approve them.'), { mode: mode === 'web' ? t(' once it pulls your web changes') : '', path: instructionsPath })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="mono-number text-xs text-muted-foreground">{interpolate(t('{rules} · {lines}'), { rules: interpolate(t(loaded === 1 ? '{count} rule' : '{count} rules'), { count: loaded }), lines: interpolate(t(lines.length === 1 ? '{count} line' : '{count} lines'), { count: lines.length }) })}</p>
            <Button variant="outline" size="sm" onClick={() => copy('file', lines.map((line) => line.text).join('\n'))}>{fileCopied === 'copied' ? <CheckIcon /> : <CopyIcon />}{fileCopied === 'copied' ? t(COPY_OUTCOME_WORDS.copied) : t('Copy')}</Button>
          </div>
          {fileCopied === 'failed' && <p role="alert" className="text-xs text-destructive">{t(COPY_OUTCOME_WORDS.failed)}</p>}
          {/* Line numbers in their own column (not copied with the text); lines wrap at 100 characters (F3). */}
          <ol aria-label={t('File preview')} className="max-h-[60svh] overflow-auto rounded-lg border border-terminal-border bg-terminal py-3 font-mono text-[0.8125rem] leading-relaxed text-terminal-foreground">
            {lines.map((line, index) => {
              const changedNow = !!line.ruleId && changed.has(line.ruleId)
              return (
                <li key={index} className={cn('grid grid-cols-[3rem_minmax(0,100ch)] gap-x-3 pr-4', changedNow && 'bg-shipped/30')}>
                  <span aria-hidden="true" className="text-right text-terminal-foreground/60 tabular-nums select-none">{index + 1}</span>
                  <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{line.text || ' '}{changedNow && <span className="sr-only"> ({t('Changed just now')})</span>}</span>
                </li>
              )
            })}
          </ol>
          {sourceKind === 'sample' && <p className="text-xs text-muted-foreground">{t("Wireframe: this preview is built from the page’s sample state; nothing is written to disk.")}</p>}
        </DialogContent>
      </Dialog>
    </Req>
  )
}

/** Where an edit is saved from and how fresh every machine is (§13.5, §13.6): one fold row, closed by default. */
function WhereEditsGo() {
  const { mode } = useWorkspace()
  const { sourceKind } = useWorkModel()
  const cloud = sourceKind === 'cloud'
  const sample = sourceKind === 'sample'
  const RowIcon = cloud || (sample && mode === 'web') ? (cloud ? CloudIcon : GlobeIcon) : LaptopIcon
  const title = sample
    ? mode === 'web' ? t('Your edits save from the web') : interpolate(t('Your edits save on {name}'), { name: HERE.name })
    : cloud ? t("Your edits save in your cloud viewer") : t("Your edits save on this computer")
  // Three short lines with icons (c-rules-where-edits-go M), "work-state record" in plain words (F).
  const lines = sample
    ? [
      { icon: SaveIcon, text: mode === 'web' ? t('Each change is written as a “web” device record.') : t('Each change is saved as a record claude-mem keeps of your decisions.') },
      { icon: RefreshCwIcon, text: mode === 'web' ? t('Every machine pulls it down on its next sync.') : t('It syncs to your other machines.') },
      { icon: FileTextIcon, text: t('MY-RULES.md is rebuilt after every change.') },
    ]
    : [
      { icon: SaveIcon, text: cloud ? t('Each change is saved in your cloud viewer as a record claude-mem keeps of your decisions.') : t('Each change is saved on this computer as a record claude-mem keeps of your decisions.') },
      { icon: RefreshCwIcon, text: cloud ? t('It syncs to your computers like the rest of your work.') : t('It syncs like the rest of your work.') },
      { icon: FileTextIcon, text: cloud ? t('Each computer rebuilds MY-RULES.md when it pulls the change.') : t('MY-RULES.md is rebuilt here after every change.') },
    ]
  return (
    <Req ids={['R13.7', 'R13.8', 'R13.1']}>
      <Collapsible>
        <CollapsibleFoldTrigger><span className="flex items-center gap-2"><RowIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />{title}</span></CollapsibleFoldTrigger>
        <CollapsibleContent>
          <ul className="space-y-1.5 px-1 pt-2 text-xs text-muted-foreground">
            {lines.map(({ icon: Icon, text }) => <li key={text} className="flex items-start gap-2"><Icon aria-hidden="true" className="mt-px size-3.5 shrink-0" />{text}</li>)}
          </ul>
          {sample && (
            <ul className="mt-2 space-y-0.5 px-1 text-xs text-muted-foreground">
              {SAMPLE_DEVICES.filter((device) => mode === 'web' || device.id !== HERE.id).map((device) => (
                <li key={device.id} className="flex items-center gap-1.5">
                  <span className={cn('size-1.5 rounded-full', device.online ? 'bg-shipped-foreground' : 'bg-idle-foreground')} />
                  {device.name}<span className="ml-auto tabular">{device.syncedMinutesAgo === 0 ? t("synced now") : interpolate(t('synced {minutes} min ago'), { minutes: device.syncedMinutesAgo })}</span>
                </li>
              ))}
            </ul>
          )}
        </CollapsibleContent>
      </Collapsible>
    </Req>
  )
}

/** A learning run's three numbers as a small table (c-rules-learning-run M1), in the reader's number format (rule 9). */
function LearningRunNumbers({ learning, run, earlier }: { learning: RulesLearning; run: SkillRun; earlier: boolean }) {
  const { t, locale } = useI18n()
  const alreadyDecided = learning.preferencesFound - learning.newSuggestions
  return (
    <div data-slot="learning-run-numbers" className="space-y-2 text-xs">
      <table className="w-full">
        <tbody className="divide-y">
          <tr><th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">{t('Request reviews read')}</th><td className="mono-number py-1.5 text-right">{learning.reviewsRead.toLocaleString(locale)}</td></tr>
          <tr><th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">{t('Preferences found')}</th><td className="mono-number py-1.5 text-right">{learning.preferencesFound.toLocaleString(locale)}</td></tr>
          <tr>
            <th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">{earlier ? t('Waiting for your decision after it') : t('Waiting for your decision')}</th>
            <td className="mono-number py-1.5 text-right text-attention-foreground">{learning.newSuggestions.toLocaleString(locale)}</td>
          </tr>
        </tbody>
      </table>
      {/* Why found and waiting differ (F3): a found preference you already decided is not suggested again. */}
      {alreadyDecided > 0 && <p className="text-muted-foreground">{interpolate(alreadyDecided === 1 ? t('The other {count} is already decided.') : t('The other {count} are already decided.'), { count: alreadyDecided.toLocaleString(locale) })}</p>}
      <p className="text-muted-foreground">{interpolate(t('Ran on {device}.'), { device: run.deviceName })}</p>
    </div>
  )
}

/**
 * What the last learning run (request-progress) read and found, and where it ran (§14; c-rules-learning-run): a fold
 * row with the run's time, holding the three numbers as a small table. When the latest refresh failed, the box says so
 * in plain words: the refresh runs owner-goals and request-progress, so it names the refresh, not the learning run (a
 * failure can come from either). It offers the one start button (ManualRefreshButton) and the raw cause under Details
 * (G17), and the last good run's numbers are marked as that earlier run's, never presented as current.
 */
function LearningRun({ refresh }: { refresh: AutoRefresh | null }) {
  const { t } = useI18n()
  const { mode } = useWorkspace()
  const { sourceKind, rulesLearning, lastRuns } = useWorkModel()
  const run = lastRuns.progress
  const failed = refresh?.state === 'failed'
  if (failed) {
    return (
      <Req ids={['R14.10', 'R14.13', 'R7.3']}>
        <div data-slot="learning-run-failed" className="space-y-3 rounded-xl border border-attention-border bg-card p-4 text-sm shadow-panel">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
            <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-attention-foreground" />{t('The last refresh didn’t finish')}
            {refresh.finishedAt && <span className="mono-number ml-auto text-xs font-normal text-muted-foreground">{displayTime(refresh.finishedAt)}</span>}
          </p>
          <p>{t('A refresh updates your goals and learns new rules from your requests. This one stopped, so rules from your latest requests may be missing.')}</p>
          {/* The cloud viewer cannot start a run on a computer; this computer's worker (and the sample) can. */}
          {sourceKind === 'cloud'
            ? <p className="text-xs text-muted-foreground">{t('claude-mem learns again on its own whenever new work is due, using the agent you are logged in to.')}</p>
            : <ManualRefreshButton ids={['R14.13']} />}
          {refresh.error && <ErrorDetails cause={refresh.error} />}
          {rulesLearning && run && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs font-medium">{interpolate(t('The last learning run that finished, {date}'), { date: displayTime(run.lastRunAt) })}</p>
              <LearningRunNumbers learning={rulesLearning} run={run} earlier />
            </div>
          )}
        </div>
      </Req>
    )
  }
  if (!rulesLearning || !run) return null
  return (
    <Req ids={['R14.10', 'R14.13', 'R7.3']}>
      <Collapsible>
        <CollapsibleFoldTrigger>
          <span className="flex items-start gap-2">
            <SparklesIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">{t("Last learning run")}<span className="mono-number block text-xs font-normal text-muted-foreground">{displayTime(run.lastRunAt)}</span></span>
          </span>
        </CollapsibleFoldTrigger>
        <CollapsibleContent>
          <div className="space-y-2 px-1 pt-2 text-xs">
            <LearningRunNumbers learning={rulesLearning} run={run} earlier={false} />
            <p className="text-muted-foreground">{sourceKind !== 'sample' ? t("claude-mem learns again on its own whenever new work is due, using the agent you are logged in to.") : mode === 'web' ? t("From the web, Refresh queues the run for the next machine online; it needs your local transcripts.") : t("Refresh runs on this machine’s worker, which reads your Claude Code and Codex transcripts.")}</p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Req>
  )
}

// ---------- Editor ----------

/** `scopeId` is a loaded scope's id, or NEW_PROJECT / NEW_SITUATION with `newScopeName`. */
interface Draft { id: string | null; scopeId: string; newScopeName: string; when: string; then: string; approving: boolean }
const NEW_SCOPE: Record<string, RuleTier> = { 'new:project': 'project', 'new:situation': 'situation' }

function draftToRule(draft: Draft, scopes: RuleScope[]): NonNullable<RuleChange['rule']> {
  const newTier = NEW_SCOPE[draft.scopeId]
  if (newTier) return { scopeTier: newTier, scopeName: draft.newScopeName.trim(), when: draft.when.trim(), then: draft.then.trim() }
  const scope = scopes.find((entry) => entry.id === draft.scopeId)
  if (!scope) throw new Error(`No rule scope ${draft.scopeId}`)
  return { scopeTier: scope.tier, scopeName: scope.name, when: draft.when.trim(), then: draft.then.trim() }
}

/** True once the person typed or chose something the draft did not start with: closing then asks first (D b8 M173). */
const draftChanged = (draft: Draft, start: Draft) => draft.scopeId !== start.scopeId || draft.newScopeName !== start.newScopeName || draft.when !== start.when || draft.then !== start.then

/**
 * Add, edit, or edit-then-approve a rule (§14: people set rules too; c-rules-rule-editor): three fields of one shape
 * with ≥3:1 edges, examples as helper lines under the fields (the owner's own rules, R12.1), "Then" marked required,
 * a "Reads as" line, Cancel beside Save, and Save disabled with its reason while "Then" is empty (G16). The "Then" field
 * is the app's Textarea: the vanish input's arrow button and particle effect are not used here
 * (c-aceternity-placeholders-and-vanish-input M1, M4, F6); its rotating examples stay, as the helper line. A failed
 * save says so in plain words, with the raw cause under Details (G17). `onCloseAutoFocus` places focus when the button
 * that opened the editor is gone (an approved rule's card is redrawn as the next rule's).
 */
function RuleEditor({ draft, start, error, saving, onChange, onClose, onSave, onCloseAutoFocus }: {
  draft: Draft | null; start: Draft | null; error: string | null; saving: boolean
  onChange: (draft: Draft) => void; onClose: () => void; onSave: () => void; onCloseAutoFocus: (event: Event) => void
}) {
  return (
    <Req ids={['R14.9', 'R13.7']}>
      <Dialog open={draft !== null} onOpenChange={(open) => { if (!open && !saving) onClose() }}>
        {draft && (
          <DialogContent hasUnsavedText={!!start && draftChanged(draft, start)} onCloseAutoFocus={onCloseAutoFocus} className="sm:max-w-lg">
            {/* Mounted per opening, so the editor opens clean every time (quality M2: the "Then" error carried over). */}
            <RuleEditorFields draft={draft} error={error} saving={saving} onChange={onChange} onSave={onSave} />
          </DialogContent>
        )}
      </Dialog>
    </Req>
  )
}

function RuleEditorFields({ draft, error, saving, onChange, onSave }: { draft: Draft; error: string | null; saving: boolean; onChange: (draft: Draft) => void; onSave: () => void }) {
  const { mode } = useWorkspace()
  const { sourceKind, rules, ruleScopes } = useWorkModel()
  const reasonId = useId()
  const thenHelpId = useId()
  const whenHelpId = useId()
  const newTier = NEW_SCOPE[draft.scopeId]
  // Examples are the owner's own rules and scopes (R12.1), never made-up ones; none when there are none.
  const ownRules = rules.filter((rule) => rule.status === 'on' || rule.status === 'off')
  const ownThens = ownRules.map((rule) => rule.then)
  const whenExample = ownRules.find((rule) => rule.when)?.when
  const scopeNameExample = newTier && ruleScopes.find((scope) => scope.tier === newTier)?.name
  const [example, setExample] = useState(0)
  const [thenLeftEmpty, setThenLeftEmpty] = useState(false)
  const thenEmpty = !draft.then.trim()
  const scopeNameMissing = !!newTier && !draft.newScopeName.trim()
  const waitsFor = thenEmpty ? t('Save waits for the “Then” part: what the agent should do.') : scopeNameMissing ? (newTier === 'project' ? t('Save waits for the repo’s name.') : t('Save waits for the situation’s name.')) : null
  return (
    <>
      <DialogHeader>
        <DialogTitle>{draft.approving ? t("Edit, then approve") : draft.id ? t("Edit rule") : t("Add a rule")}</DialogTitle>
        <DialogDescription>{t("Write it the way you’d say it. Saving puts it in MY-RULES.md, which loads with your user-level instructions from the next session.")}</DialogDescription>
      </DialogHeader>
      <fieldset className="grid gap-4" disabled={saving}>
        <div className="grid gap-1.5"><Label htmlFor="rule-scope">{t("Applies")}</Label>
          <Select value={draft.scopeId} onValueChange={(scopeId) => onChange({ ...draft, scopeId })}>
            <SelectTrigger id="rule-scope" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RULE_TIERS.map(({ tier, label }) => (
                <SelectGroup key={tier}>
                  <SelectLabel>{t(label)}</SelectLabel>
                  {ruleScopes.filter((scope) => scope.tier === tier).map((scope) => <SelectItem key={scope.id} value={scope.id}>{scope.tier === 'everywhere' ? t('Everywhere') : scope.name}</SelectItem>)}
                  {tier !== 'everywhere' && <SelectItem value={`new:${tier}`}>{tier === 'project' ? t("A new repo…") : t("A new situation…")}</SelectItem>}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
        {newTier && (
          <div className="grid gap-1.5"><Label htmlFor="rule-scope-name" required>{newTier === 'project' ? t("Repo") : t("Situation")}</Label>
            <Input id="rule-scope-name" required value={draft.newScopeName} onChange={(event) => onChange({ ...draft, newScopeName: event.target.value })} aria-describedby={scopeNameExample ? `${whenHelpId}-scope` : undefined} />
            {scopeNameExample && <FieldHelperText id={`${whenHelpId}-scope`}>{interpolate(t('Example: {example}'), { example: scopeNameExample })}</FieldHelperText>}
          </div>
        )}
        <div className="grid gap-1.5"><Label htmlFor="rule-when" optional>{t('When')}</Label>
          <Input id="rule-when" value={draft.when} onChange={(event) => onChange({ ...draft, when: event.target.value })} aria-describedby={whenExample ? whenHelpId : undefined} />
          {whenExample && <FieldHelperText id={whenHelpId}>{interpolate(t('Example: {example}'), { example: whenExample })}</FieldHelperText>}
        </div>
        <div className="grid gap-1.5"><Label htmlFor="rule-then" required>{t("Then")}</Label>
          <Textarea id="rule-then" required rows={3} value={draft.then} aria-describedby={ownThens.length ? thenHelpId : undefined}
            error={thenLeftEmpty && thenEmpty ? t('Say what the agent should do. This part is required.') : undefined}
            onChange={(event) => onChange({ ...draft, then: event.target.value })}
            onBlur={() => setThenLeftEmpty(true)} />
          {ownThens.length > 0 && (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <FieldHelperText id={thenHelpId} className="min-w-0">{interpolate(t('Example: {example}'), { example: ownThens[example % ownThens.length] })}</FieldHelperText>
              {ownThens.length > 1 && <Button variant="link" size="xs" className="h-auto px-0 text-xs" onClick={() => setExample((index) => index + 1)}>{t('Another example')}</Button>}
            </div>
          )}
        </div>
        {!thenEmpty && (
          <div className="grid gap-1.5">
            <p className="section-label">{t('Reads as')}</p>
            <p data-slot="rule-reads-as" className="rounded-lg border border-control-edge/55 bg-muted/40 px-3.5 py-2.5 text-sm">{ruleLine(draft)}</p>
          </div>
        )}
        {/* G17: plain words; the raw cause (the worker's reason, or a scope the page no longer lists) under Details. */}
        {error && (
          <div role="alert" data-slot="rule-save-failed" className="space-y-1">
            <FieldHelperText tone="error">{t('The rule was not saved.')}</FieldHelperText>
            <ErrorDetails cause={error} />
          </div>
        )}
      </fieldset>
      <DialogFooter className="gap-3 sm:flex-wrap sm:items-center">
        <p className="text-xs text-muted-foreground sm:mr-auto">{sourceKind === 'cloud' ? t("Saves in your cloud viewer as a work-state record; it syncs to your computers.") : sourceKind !== 'sample' ? t("Saves on this computer as a work-state record.") : mode === 'web' ? t("Saves from the web; every machine pulls it down.") : interpolate(t('Saves on {name} and syncs to your other machines.'), { name: HERE.name })}</p>
        <DialogClose asChild><Button variant="outline">{t('Cancel')}</Button></DialogClose>
        <Button onClick={onSave} busy={saving} busyLabel={t("Saving…")} aria-disabled={waitsFor ? true : undefined} aria-describedby={waitsFor ? reasonId : undefined}>
          {draft.approving ? t("Save and approve") : t("Save rule")}
        </Button>
        {waitsFor && <p id={reasonId} data-slot="save-waits-for" className="basis-full text-xs text-muted-foreground sm:text-right">{waitsFor}</p>}
      </DialogFooter>
    </>
  )
}

// ---------- Page ----------

/**
 * No story and no saved rules yet: say so, and how to get learned rules, instead of showing anything made up. When
 * the rules cannot be read: plain words, Try again (a fresh read), and the raw cause under Details (G17).
 */
export function NoRulesYet({ onAdd, readError, refresh }: { onAdd: () => void; readError: string | null; refresh: AutoRefresh | null }) {
  const [reading, setReading] = useState(false)
  const waiting = refresh?.state === 'waiting-for-agent'
  const description = waiting
    ? t('Rule learning is waiting for an agent. Sign in to a supported agent on the worker machine, or add a rule yourself.')
    : t('claude-mem learns how you like to work from your requests on its own. You can also add one.')
  const readAgain = () => { setReading(true); void useStore.getState().retryWorkRead().finally(() => setReading(false)) }
  return (
    <Req ids={['R12.1']}>
      <Empty className="border bg-card/60">
        <EmptyHeader>
          <EmptyTitle>{readError ? t("Can’t read your rules right now") : t("No rules yet")}</EmptyTitle>
          <EmptyDescription>{readError ? t('My Rules could not read your saved rules. Nothing was changed; they show here again once the read works.') : description}</EmptyDescription>
          {!readError && waiting && <RefreshStatus refresh={refresh} run={null} ids={['R14.13']} />}
        </EmptyHeader>
        <EmptyContent className="items-center gap-3">
          {readError
            ? <>
              <Button busy={reading} busyLabel={t('Reading…')} onClick={readAgain}><RefreshCwIcon />{t('Try again')}</Button>
              <div className="w-full max-w-md text-left"><ErrorDetails cause={readError} /></div>
            </>
            : <Button onClick={onAdd}><PlusIcon />{t("Add rule")}</Button>}
        </EmptyContent>
      </Empty>
    </Req>
  )
}

/** What the page holds (page-07 M1). Drawn once per width: at the top from the sm width, after the queue on phones. */
function RulesPageDescription({ className }: { className: string }) {
  return (
    <p className={cn('text-sm text-muted-foreground', className)}>
      <span className="hidden sm:inline">{t('How you like to work, as if-then rules.')}{' '}</span>{t("Rules you set or approve go in MY-RULES.md, loaded with your user-level instructions. Learned ones wait here until you decide.")}
    </p>
  )
}

// A jumped-to rule keeps its highlight 1.8 s: the smooth scroll to a rule far down the page takes up to about 1 s, and
// the highlight then stays long enough to spot the rule. Only the background changes; nothing folds or moves.
const JUMP_HIGHLIGHT_MS = 1800

export function MyRules() {
  useI18n()
  const { mode } = useWorkspace()
  const { sourceKind, rules, ruleScopes, rulesLearning, rulesReadError, lastRuns, refresh } = useWorkModel()
  const sample = sourceKind === 'sample'
  // Saves, their receipts and Undo live in the store (rules-slice.ts), so live updates and leaving the page keep them.
  const { savedDecisions, history, changedIds, saving, saveError } = useStore.use.rules()
  const { runRuleSave, undoLastRuleChange, setRuleSaveError } = useStore.getState()
  // A decision shows as decided only while the rule is still the version that decision saved.
  const decisions = useMemo(() => currentRuleDecisions(rules, savedDecisions), [rules, savedDecisions])
  const changed = useMemo(() => new Set(changedIds), [changedIds])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftStart, setDraftStart] = useState<Draft | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [fileOpen, setFileOpen] = useState(false)
  // Which waiting rule the queue shows in full; null: the first one still waiting.
  const [pointer, setPointer] = useState<string | null>(null)
  const lastChange = history.at(-1) ?? null
  const canUndoLast = !!lastChange?.undo && !!lastChange.ruleId && ruleUndoIsCurrent(lastChange.ruleId, lastChange.expectedVersion, rules)

  const suggestions = useMemo(() => rules.filter((rule) => rule.status === 'suggested' || rule.id in decisions).sort(byStrength), [rules, decisions])
  const waiting = suggestions.filter((rule) => !decisions[rule.id]).length
  const approvedNow = new Set(Object.entries(decisions).filter(([, decision]) => decision === 'approved').map(([id]) => id))
  // The decision made last, from the receipts: its card shows as a one-line result above the next rule.
  const lastDecidedId = [...history].reverse().find((record) => record.ruleId && decisions[record.ruleId])?.ruleId ?? null
  // The last switch of a rule, while it is still the latest change: shown on that rule with its Undo.
  const toggled: ToggleResult | null = lastChange?.ruleId && (lastChange.undo?.action === 'turn-on' || lastChange.undo?.action === 'turn-off')
    ? { ruleId: lastChange.ruleId, on: lastChange.undo.action === 'turn-off', canUndo: !saving && canUndoLast, onUndo: () => void undoLastRuleChange() }
    : null

  const countsByScope = new Map(ruleScopes.map((scope) => {
    const inScope = rules.filter((rule) => rule.scopeId === scope.id)
    const count = (status: OwnerRule['status']) => inScope.filter((rule) => rule.status === status).length
    return [scope.id, { on: count('on'), off: count('off'), suggested: count('suggested'), replaced: count('replaced') }]
  }))
  const onCount = rules.filter((rule) => rule.status === 'on').length

  /**
   * Saves one change from the page and says whether it was saved; a refusal shows above the rules. The receipt describes
   * the rule as the save returned it.
   */
  const save = (change: RuleChange, describe: (saved: RuleSaveResult) => RuleSaveOutcome): Promise<boolean> =>
    runRuleSave(change, describe).then((saved) => saved !== null, (error: unknown) => { setRuleSaveError(error instanceof Error ? error.message : String(error)); return false })
  const jump = (ruleId: string) => {
    scrollToId(`rule-${ruleId}`)
    setHighlighted(ruleId)
    setTimeout(() => setHighlighted(null), JUMP_HIGHLIGHT_MS)
  }
  const ruleName = (rule: Pick<OwnerRule, 'then'>) => `“${lowerFirst(rule.then).replace(/\.$/, '')}”`
  const headingFor = (scopeId: string, scopes: RuleScope[]) => { const scope = scopes.find((entry) => entry.id === scopeId); return scope ? scope.tier === 'everywhere' ? uiMessage('Everywhere') : scope.name : uiMessage('its scope') }
  const savedRule = (saved: RuleSaveResult, rule: OwnerRule) => saved.model.rules.find((entry) => entry.id === rule.id) ?? rule

  const decide = (rule: OwnerRule, decision: Decision) => save({ action: decision === 'approved' ? 'approve' : 'dismiss', ruleId: rule.id }, (saved) => {
    const named = savedRule(saved, rule)
    return {
      decision: { ruleId: rule.id, decision },
      change: { ...ruleReceipt(decision === 'approved' ? 'Approved {name} under {scope}' : 'Rejected {name}', { name: ruleName(named), ...(decision === 'approved' ? { scope: headingFor(named.scopeId, saved.model.ruleScopes) } : {}) }), ruleId: rule.id, undo: { action: 'restore-suggestion', ruleId: rule.id } },
    }
  })
  const undoDecision = (rule: OwnerRule) => save({ action: 'restore-suggestion', ruleId: rule.id }, (saved) => ({
    decision: { ruleId: rule.id, decision: null },
    change: { ...ruleReceipt('Put {name} back in Needs your decision', { name: ruleName(savedRule(saved, rule)) }), ruleId: rule.id, undo: null },
  }))
  // The button that opened the editor, so focus can go somewhere sensible when that button is gone at close.
  const draftOpener = useRef<Element | null>(null)
  const openDraft = (next: Draft) => { draftOpener.current = document.activeElement; setDraftError(null); setDraft(next); setDraftStart(next) }
  // An approved rule's card is redrawn as the next rule's, so its "Edit first" is gone: focus goes to the queue's
  // target (the next rule, else the result, else the heading), never the page body (quality M5).
  const placeFocusAfterEditor = (event: Event) => {
    const opener = draftOpener.current
    draftOpener.current = null
    if (!opener || opener.isConnected) return
    event.preventDefault()
    focusQueueTarget(document.getElementById('decide'))
  }
  const actions: RuleActions = {
    saving,
    onToggle: (rule, on) => save({ action: on ? 'turn-on' : 'turn-off', ruleId: rule.id },
      (saved) => ({ change: { ...ruleReceipt(on ? 'Turned on {name}' : 'Turned off {name}', { name: ruleName(savedRule(saved, rule)) }), ruleId: rule.id, undo: { action: on ? 'turn-off' : 'turn-on', ruleId: rule.id } } })),
    onEdit: (rule) => openDraft({ id: rule.id, scopeId: rule.scopeId, newScopeName: '', when: rule.when, then: rule.then, approving: false }),
    onJump: jump,
    onRestore: (rule) => void undoDecision(rule),
  }
  const closeDraft = () => { setDraft(null); setDraftStart(null) }
  const saveDraft = async () => {
    if (!draft || saving || !draft.then.trim() || (NEW_SCOPE[draft.scopeId] && !draft.newScopeName.trim())) return
    setDraftError(null)
    let rule: NonNullable<RuleChange['rule']>
    try { rule = draftToRule(draft, ruleScopes) } catch (error) { setDraftError(error instanceof Error ? error.message : String(error)); return }
    const before = draft.id ? rules.find((entry) => entry.id === draft.id) : undefined
    const previousRule = before && { ...draftToRule({ ...draft, scopeId: before.scopeId, when: before.when, then: before.then }, ruleScopes) }
    const change: RuleChange = draft.id ? { action: draft.approving ? 'approve' : 'edit', ruleId: draft.id, rule } : { action: 'add', rule }
    const describe = (saved: RuleSaveResult): RuleSaveOutcome => {
      if (draft.id) {
        const named = saved.model.rules.find((entry) => entry.id === draft.id) ?? rule
        const done: Omit<RuleChangeRecord, 'expectedVersion'> = { ...ruleReceipt(draft.approving ? 'Edited and approved {name}' : 'Edited {name}', { name: ruleName(named) }), ruleId: draft.id, undo: draft.approving ? { action: 'restore-suggestion', ruleId: draft.id } : { action: 'edit', ruleId: draft.id, rule: previousRule } }
        return draft.approving ? { change: done, decision: { ruleId: draft.id, decision: 'approved' } } : { change: done }
      }
      // The worker names the rule it saved; an older one leaves only a unique match to go on, never the first new row.
      const added = addedRuleFromSave(saved.model, rules, rule, saved.savedRuleId ?? undefined)
      return { change: added
        ? { ...ruleReceipt('Added {name} under {scope}', { name: ruleName(added), scope: headingFor(added.scopeId, saved.model.ruleScopes) }), ruleId: added.id, undo: { action: 'dismiss', ruleId: added.id } }
        : { ...ruleReceipt('Saved {name}', { name: ruleName(rule) }), ruleId: null, undo: null } }
    }
    try {
      if (await runRuleSave(change, describe)) closeDraft()
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error))
    }
  }
  const startAdding = () => openDraft({ id: null, scopeId: 'everywhere', newScopeName: '', when: '', then: '', approving: false })
  const review = (ruleId: string) => { setPointer(ruleId); scrollToId('decide') }
  const editor = <RuleEditor draft={draft} start={draftStart} error={draftError} saving={saving} onChange={setDraft} onClose={closeDraft} onSave={() => void saveDraft()} onCloseAutoFocus={placeFocusAfterEditor} />

  if (rulesReadError || (!sample && rules.length === 0 && !rulesLearning)) {
    return (
      <div className="space-y-5">
        <NoRulesYet onAdd={startAdding} readError={rulesReadError} refresh={refresh} />
        {editor}
      </div>
    )
  }

  return (
    <Req ids={['R4.6', 'R7.3']}>
      <div className="space-y-5">
        {/* The page's h1 is "My Rules" in the header bar (Phase 2); its two counts lead the page (page-07 M1). On phones
            Add rule shares their row and the description follows the queue, so the rule to decide starts higher on the
            first screen and its sentence clears the decision row (Phase 7 verify). */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Req ids={['R12.3', 'R12.2', 'D7']}>
            <div className="min-w-0 max-w-2xl flex-1 basis-56 space-y-1">
              <p className="text-base leading-snug font-medium tabular">
                {waiting > 0 ? interpolate(t(waiting === 1 ? '{waiting} learned rule is waiting for you.' : '{waiting} learned rules are waiting for you.'), { waiting }) : t('Nothing is waiting for you.')}{' '}
                {interpolate(t(onCount === 1 ? '{onCount} rule is on.' : '{onCount} rules are on.'), { onCount })}
              </p>
              <RulesPageDescription className="max-sm:hidden" />
            </div>
          </Req>
          {/* Outlined: the page's one orange button is Approve on the current rule (page-07 M3, G1). */}
          <Req ids={['R14.9']}><Button variant="outline" onClick={startAdding}><PlusIcon />{t("Add rule")}</Button></Req>
        </div>

        {/* G17: plain words; a raw cause (the worker's reason) under Details. The store's own refusal of a stale Undo is
            written for people, so it is the line itself. */}
        {saveError && (
          <div role="alert" data-slot="rule-change-failed" className="space-y-1 border-l-2 border-attention-border py-1 pl-3 text-xs">
            <p className="text-attention-foreground">{saveError === RULE_CHANGED_SINCE_EDIT ? t(RULE_CHANGED_SINCE_EDIT) : t('The rule change was not saved.')}</p>
            {saveError !== RULE_CHANGED_SINCE_EDIT && <ErrorDetails cause={saveError} />}
          </div>
        )}
        {lastChange && (
          <Req ids={['R13.7', 'D7']}>
            <div role="status" className="space-y-1 border-l-2 border-shipped-border py-1 pl-3 text-xs">
              <p className="flex items-start gap-1.5 font-medium text-shipped-foreground"><CheckIcon className="mt-px size-3.5 shrink-0" />{renderRuleReceipt(lastChange)}.</p>
              <p className="text-muted-foreground">{savedWhere(mode, sample)}.{sample && <span className="italic">{' '}{t('Wireframe: not actually written.')}</span>}</p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={() => setFileOpen(true)}>{t("View in MY-RULES.md")}</Button>
                {rules.some((rule) => rule.id === lastChange.ruleId && (rule.status === 'on' || rule.status === 'off')) && <Button variant="outline" size="sm" onClick={() => jump(lastChange.ruleId!)}>{t("Show the rule")}</Button>}
                <Button variant="outline" size="sm" onClick={() => void undoLastRuleChange()} disabled={saving || !canUndoLast}>{t("Undo")}</Button>
              </div>
            </div>
          </Req>
        )}

        <ScopeChips countsByScope={countsByScope} waiting={waiting} />

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="min-w-0 space-y-8">
            <DecisionQueue suggestions={suggestions} decisions={decisions} lastDecidedId={lastDecidedId} saving={saving} pointer={pointer} onPoint={setPointer}
              onDecide={decide} onUndo={undoDecision} onShow={(rule) => jump(rule.id)}
              onEdit={(rule) => openDraft({ id: rule.id, scopeId: rule.scopeId, newScopeName: '', when: rule.when, then: rule.then, approving: true })} />
            <RulesPageDescription className="sm:hidden" />
            {ruleScopes.map((scope) => (
              <ScopeSection key={scope.id} scope={scope} rules={rules.filter((rule) => rule.scopeId === scope.id)} counts={countsByScope.get(scope.id)!}
                approvedNow={approvedNow} highlighted={highlighted} toggled={toggled} actions={actions} onReview={review} />
            ))}
            {/* The shared refresh line, at the foot of the page (page-07 M5); its plain-words version comes with Phase 3. */}
            <div className="min-w-0 border-t pt-3 [overflow-wrap:anywhere]">
              {sample ? <RefreshButton run={SAMPLE_RUNS.rules} ids={['R14.13', 'R11.1']} /> : <RefreshStatus refresh={refresh} run={lastRuns.progress} ids={['R14.13']} />}
            </div>
          </div>

          {/* Only the jump list stays in view while the page scrolls (a whole sticky column was taller than a 900px
              window once a fold opened, and its last box could not be reached until the page's end). It comes last in
              the column, as page-07 draws MY-RULES.md first: a sticky box only ever moves down from its place, so the
              boxes above it scroll away before it sticks and it never covers them, whatever their height or the
              number of scopes. */}
          <aside className="space-y-4">
            <AgentFile rules={rules} changed={changed} open={fileOpen} onOpenChange={setFileOpen} />
            <WhereEditsGo />
            <LearningRun refresh={refresh} />
            <div className="hidden lg:sticky lg:top-20 lg:block"><ScopeNav countsByScope={countsByScope} waiting={waiting} /></div>
          </aside>
        </div>

        {editor}
      </div>
    </Req>
  )
}
