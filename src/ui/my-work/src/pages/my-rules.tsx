import { useMemo, useState, type ReactNode } from 'react'
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, FileTextIcon, HistoryIcon, PencilIcon, PlusIcon, SparklesIcon, XIcon } from 'lucide-react'
import { Artifact, ArtifactDescription, ArtifactHeader, ArtifactTitle } from '@/components/ai-elements/artifact'
import { Confirmation, ConfirmationAccepted, ConfirmationAction, ConfirmationActions, ConfirmationRejected, ConfirmationRequest, ConfirmationTitle, type ConfirmationProps } from '@/components/ai-elements/confirmation'
import { InlineCitation, InlineCitationCard, InlineCitationCardBody, InlineCitationCardTrigger, InlineCitationText } from '@/components/ai-elements/inline-citation'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { RefreshButton, StateBadge, useWorkspace } from '@/components/bits'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { SAMPLE_DEVICES, SAMPLE_RUNS } from '@/data'
import { OWNER_RULES, RULE_SCOPES, RULE_TIERS, RULES_LEARNING, type OwnerRule, type RuleQuote, type RuleScope } from '@/data-rules'

// ---------- Derived facts ----------

const scopeById = (id: string) => RULE_SCOPES.find((scope) => scope.id === id)!
const scopeHeading = (scope: RuleScope) => scope.tier === 'project' ? `In ${scope.name}` : scope.name

/** Strength (§14): times seen × how recent. Shown in words, never as a raw score. */
const strengthScore = (rule: OwnerRule) => rule.timesSeen / (1 + rule.latestDaysAgo / 7)
const strengthLevel = (rule: OwnerRule) => { const score = strengthScore(rule); return score >= 4 ? 3 : score >= 1.5 ? 2 : 1 }
const STRENGTH_WORD = ['', 'Light', 'Steady', 'Strong']
const byStrength = (a: OwnerRule, b: OwnerRule) => strengthScore(b) - strengthScore(a)
const setByText = (rule: OwnerRule) => rule.setBy === 'owner' ? 'Set by you' : rule.setBy === 'approved' ? `Learned, approved by you` : 'Learned, not approved yet'
const sourceText = (rule: OwnerRule) => rule.source === 'you' ? 'From your own instructions.' : `Found by ${rule.source}.`
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)
const scrollToId = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })

// ---------- Small pieces ----------

/** The if-then block, read as one plain-English sentence split across two aligned lines (§14). */
function RuleSentence({ rule, struck = false, large = false }: { rule: OwnerRule; struck?: boolean; large?: boolean }) {
  return (
    <Req ids={['R14.3', 'R10.5']}>
      <dl className={cn('grid grid-cols-[2.75rem_1fr] gap-x-2 gap-y-0.5', large ? 'text-[15px]' : 'text-sm', struck && 'line-through decoration-idle-foreground/50')}>
        <dt className="pt-px text-xs font-medium text-muted-foreground">When</dt>
        <dd className="text-muted-foreground">{rule.when}</dd>
        <dt className="pt-px text-xs font-medium text-muted-foreground">Then</dt>
        <dd className="leading-snug font-medium">{lowerFirst(rule.then)}</dd>
      </dl>
    </Req>
  )
}

/** Status uses the same state language as My Work (§6): on reads as shipped, suggested as waiting for a check. */
function RuleStatusBadge({ rule, justApproved }: { rule: OwnerRule; justApproved?: boolean }) {
  const label = justApproved ? 'Approved just now' : { on: 'On', off: 'Off', suggested: 'Suggested', replaced: 'Replaced', dismissed: 'Rejected' }[rule.status]
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

/** Strength in human terms: a three-step meter, the word, times seen and the latest date (§14). */
function Strength({ rule }: { rule: OwnerRule }) {
  const level = strengthLevel(rule)
  return (
    <Req ids={['R14.14', 'R14.7']}>
      <span className="inline-flex items-center gap-1.5">
        <span className="flex items-end gap-0.5" aria-hidden>
          {[1, 2, 3].map((step) => <span key={step} className={cn('w-1 rounded-full', step === 1 ? 'h-1.5' : step === 2 ? 'h-2' : 'h-2.5', step <= level ? 'bg-current' : 'bg-idle-border')} />)}
        </span>
        <span><span className="font-medium">{STRENGTH_WORD[level]}</span> · said {rule.timesSeen} {rule.timesSeen === 1 ? 'time' : 'times'}, latest {rule.latestAt}</span>
      </span>
    </Req>
  )
}

/** One dated quote: the owner's words, with the record behind it on hover (Inline Citation). */
function Quote({ quote, rule }: { quote: RuleQuote; rule: OwnerRule }) {
  return (
    <Req ids={['R14.3', 'R14.8']}>
      <blockquote className="border-l-2 border-review-border pl-3 text-sm leading-snug">
        <InlineCitation>
          <InlineCitationText>“{quote.quote}”</InlineCitationText>
          <InlineCitationCard>
            <InlineCitationCardTrigger sources={[quote.at]} className="font-normal" />
            <InlineCitationCardBody className="space-y-1.5 p-3 text-xs">
              <p className="font-medium capitalize">{quote.kind} · {quote.where === 'prompt' ? 'typed by you' : 'your instructions file'}</p>
              {rule.records.map((record) => <p key={record.label} className="text-muted-foreground">{record.kind}: {record.label} · {record.at}</p>)}
            </InlineCitationCardBody>
          </InlineCitationCard>
        </InlineCitation>
      </blockquote>
    </Req>
  )
}

/** Third layer of disclosure: the records the rule was built from (§14: request-progress reviews, owner-goals runs, prompts). */
function SourceRecords({ rule }: { rule: OwnerRule }) {
  return (
    <Req ids={['R14.8']}>
      <div className="space-y-1">
        <p className="text-[11px] font-medium text-muted-foreground uppercase">Source records</p>
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {rule.records.map((record) => <li key={record.label} className="flex gap-2"><span className="w-20 shrink-0 font-medium text-foreground/70">{record.kind}</span><span className="min-w-0 truncate">{record.label}</span><span className="ml-auto shrink-0">{record.at}</span></li>)}
        </ul>
      </div>
    </Req>
  )
}

// ---------- Where changes are saved (§13.5, decision 7) ----------

const HERE = SAMPLE_DEVICES.find((device) => device.syncedMinutesAgo === 0)!
const OTHER_MACHINES = SAMPLE_DEVICES.filter((device) => device.id !== HERE.id).map((device) => device.name).join(' and ')
const RULES_FILE = '~/.claude-mem/MY-RULES.md'
/** Says where a change is written and how it reaches the other machines. Never claims more than that. */
const savedWhere = (mode: 'home' | 'web') => mode === 'web'
  ? `Saved from the web as a “web” device record. ${SAMPLE_DEVICES.map((device) => device.name).join(', ')} pull it on their next sync and rebuild MY-RULES.md`
  : `Saved on ${HERE.name}. MY-RULES.md is rebuilt here, and the change syncs to ${OTHER_MACHINES}`

// ---------- Rule blocks ----------

interface RuleActions {
  onToggle: (rule: OwnerRule, on: boolean) => void
  onEdit: (rule: OwnerRule) => void
  onJump: (ruleId: string) => void
}

/** An owner rule: the sentence first, then status and strength, then why (quotes) and source records on demand. */
function RuleBlock({ rule, replaces, justApproved, highlighted, actions }: { rule: OwnerRule; replaces: OwnerRule[]; justApproved: boolean; highlighted: boolean; actions: RuleActions }) {
  const off = rule.status === 'off'
  const controls = (
    <Req ids={['R14.9', 'R11.1']}>
      <div className="flex shrink-0 items-center">
        <Button variant="ghost" size="icon" className="size-11 text-muted-foreground sm:size-9" aria-label="Edit rule" onClick={() => actions.onEdit(rule)}><PencilIcon /></Button>
        <label className="flex size-11 cursor-pointer items-center justify-center">
          <span className="sr-only">{off ? 'Turn rule on' : 'Turn rule off'}</span>
          <Switch checked={!off} onCheckedChange={(next) => actions.onToggle(rule, next)} />
        </label>
      </div>
    </Req>
  )
  return (
    <Req ids={['R14.3', 'R14.9', 'R10.2']}>
      <Collapsible asChild>
        <article id={`rule-${rule.id}`} className={cn('scroll-mt-36 px-4 py-3 first:rounded-t-xl last:rounded-b-xl motion-safe:transition-colors motion-safe:duration-700 lg:scroll-mt-20', off ? 'bg-muted/50' : 'bg-card', highlighted && 'bg-accent')}>
          <div className="flex items-start gap-3">
            <div className={cn('min-w-0 flex-1', off && 'opacity-60')}><RuleSentence rule={rule} /></div>
            <div className="hidden sm:block">{controls}</div>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[3.25rem] text-xs text-muted-foreground max-sm:pl-0">
            <RuleStatusBadge rule={rule} justApproved={justApproved} />
            <Strength rule={rule} />
            <span>{setByText(rule)}</span>
            {replaces.length > 0 && (
              <Req ids={['R14.4']}>
                <button type="button" onClick={() => actions.onJump(replaces[0].id)} className="inline-flex min-h-11 items-center gap-1 hover:text-foreground sm:min-h-0">
                  <HistoryIcon className="size-3.5" />Replaced {replaces.length} earlier {replaces.length === 1 ? 'rule' : 'rules'}
                </button>
              </Req>
            )}
            <div className="ml-auto flex items-center">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="group/why h-11 text-xs text-muted-foreground sm:h-8">Why<ChevronDownIcon className="transition-transform group-data-[state=open]/why:rotate-180" /></Button>
              </CollapsibleTrigger>
              <div className="sm:hidden">{controls}</div>
            </div>
          </div>

          <CollapsibleContent className="mt-2 space-y-3 border-t pt-3 sm:ml-[3.25rem]">
            <div className="space-y-2">{rule.quotes.length ? rule.quotes.map((quote) => <Quote key={quote.quote} quote={quote} rule={rule} />) : <p className="text-xs text-muted-foreground">You wrote this rule in My Rules, so there are no quotes behind it.</p>}</div>
            {replaces.length > 0 && (
              <Req ids={['R14.4']}>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Earlier versions it replaced</p>
                  {replaces.map((earlier) => (
                    <button key={earlier.id} type="button" onClick={() => actions.onJump(earlier.id)} className="block min-h-11 w-full text-left text-xs text-muted-foreground hover:text-foreground sm:min-h-0">
                      <span className="line-through">{lowerFirst(earlier.then)}</span> · until {earlier.replacedBy!.at}
                    </button>
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

/** A replaced rule stays visible, struck and dimmed, linked to the newer rule that won and when (§14). */
function ReplacedRow({ rule, replacement, onJump }: { rule: OwnerRule; replacement: OwnerRule | undefined; onJump: (ruleId: string) => void }) {
  return (
    <Req ids={['R14.4', 'R14.7']}>
      <div id={`rule-${rule.id}`} className="scroll-mt-36 space-y-1 px-4 py-3 text-muted-foreground lg:scroll-mt-20">
        <div className="opacity-70"><RuleSentence rule={rule} struck /></div>
        <p className="flex flex-wrap items-center gap-x-1.5 pl-[3.25rem] text-xs max-sm:pl-0">
          <RuleStatusBadge rule={rule} />
          <span>on {rule.replacedBy!.at} by</span>
          {replacement && <button type="button" onClick={() => onJump(replacement.id)} className="min-h-11 text-left font-medium text-foreground underline underline-offset-2 sm:min-h-0">“{replacement.then}”</button>}
        </p>
      </div>
    </Req>
  )
}

/** Inside a scope, a suggestion is only a pointer: the full rule and the decision live once, in the queue at the top. */
function SuggestedPointer({ waiting, rejected }: { waiting: OwnerRule[]; rejected: OwnerRule[] }) {
  return (
    <Req ids={['R14.2']}>
      <div className="flex flex-wrap gap-x-4">
        {waiting.length > 0 && (
          <button type="button" onClick={() => scrollToId(`decide-${waiting[0].id}`)} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-review-foreground hover:underline">
            <ArrowUpIcon className="size-4" />{waiting.length} suggested · review above
          </button>
        )}
        {rejected.length > 0 && (
          <button type="button" onClick={() => scrollToId(`decide-${rejected[0].id}`)} className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground hover:underline">
            <ArrowUpIcon className="size-4" />{rejected.length} rejected · undo above
          </button>
        )}
      </div>
    </Req>
  )
}

// ---------- Needs a decision ----------

type Decision = 'approved' | 'rejected'

/** One suggestion: the rule and Approve / Edit / Reject first, then strength and one quote, the rest on demand. */
function SuggestionCard({ rule, decision, onDecide, onEdit, onUndo, onShow }: { rule: OwnerRule; decision: Decision | undefined; onDecide: (decision: Decision) => void; onEdit: () => void; onUndo: () => void; onShow: () => void }) {
  const scope = scopeById(rule.scopeId)
  const approval = (decision ? { id: rule.id, approved: decision === 'approved' } : { id: rule.id }) as ConfirmationProps['approval']
  const [first, ...more] = rule.quotes
  return (
    <Req ids={['R14.2', 'R14.3', 'R14.8', 'R14.9']}>
      <Confirmation id={`decide-${rule.id}`} approval={approval} state={decision ? 'approval-responded' : 'approval-requested'}
        className={cn('scroll-mt-36 gap-3 rounded-xl bg-card p-4 shadow-none lg:scroll-mt-20', !decision ? 'border-review-border' : decision === 'approved' ? 'border-shipped-border' : 'border-dashed')}>
        <button type="button" onClick={() => scrollToId(`scope-${scope.id}`)} className="-my-2 inline-flex min-h-11 w-fit items-center text-xs text-muted-foreground hover:text-foreground sm:min-h-0 sm:my-0">{scopeHeading(scope)}</button>

        <div className={cn(decision === 'rejected' && 'line-through opacity-60')}><RuleSentence rule={rule} large /></div>

        <ConfirmationRequest>
          <Req ids={['R11.1']}>
            <ConfirmationActions className="grid w-full grid-cols-3 gap-2 self-stretch sm:flex sm:w-auto sm:self-start">
              <ConfirmationAction className="order-last h-11 sm:order-first sm:h-9" onClick={() => onDecide('approved')}><CheckIcon />Approve</ConfirmationAction>
              <ConfirmationAction variant="outline" className="h-11 sm:h-9" onClick={onEdit}><PencilIcon />Edit</ConfirmationAction>
              <ConfirmationAction variant="ghost" className="order-first h-11 sm:order-last sm:h-9" onClick={() => onDecide('rejected')}><XIcon />Reject</ConfirmationAction>
            </ConfirmationActions>
          </Req>
        </ConfirmationRequest>
        <ConfirmationAccepted>
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <ConfirmationTitle className="text-sm text-shipped-foreground">Approved. It’s now under {scopeHeading(scope)} and in MY-RULES.md.</ConfirmationTitle>
            <div className="flex">
              <Button variant="ghost" size="sm" className="h-11 text-xs sm:h-8" onClick={onShow}>Show it</Button>
              <Button variant="ghost" size="sm" className="h-11 text-xs sm:h-8" onClick={onUndo}>Undo</Button>
            </div>
          </div>
        </ConfirmationAccepted>
        <ConfirmationRejected>
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <ConfirmationTitle className="text-sm text-muted-foreground">Rejected. It won’t be suggested again unless you say it again.</ConfirmationTitle>
            <Button variant="ghost" size="sm" className="h-11 text-xs sm:h-8" onClick={onUndo}>Undo</Button>
          </div>
        </ConfirmationRejected>

        {!decision && (
          <div className="space-y-2 border-t pt-3">
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><Strength rule={rule} /><span>learned by {rule.source}</span></p>
            {first && <Quote quote={first} rule={rule} />}
            {more.length > 0 && (
              <Collapsible>
                <CollapsibleContent className="space-y-2 pb-1">{more.map((quote) => <Quote key={quote.quote} quote={quote} rule={rule} />)}</CollapsibleContent>
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

function DecisionQueue({ suggestions, decisions, onDecide, onEdit, onUndo, onShow }: { suggestions: OwnerRule[]; decisions: Record<string, Decision>; onDecide: (rule: OwnerRule, decision: Decision) => void; onEdit: (rule: OwnerRule) => void; onUndo: (rule: OwnerRule) => void; onShow: (rule: OwnerRule) => void }) {
  const waiting = suggestions.filter((rule) => !decisions[rule.id]).length
  return (
    <Req ids={['R14.2', 'R12.3', 'R12.2']}>
      <section id="decide" className="scroll-mt-36 space-y-3 lg:scroll-mt-20">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-base font-semibold">Needs your decision</h2>
          {waiting > 0 && <StateBadge state="your-move" />}
          <span className="text-xs text-muted-foreground">{suggestions.length - waiting} of {suggestions.length} decided</span>
        </div>
        {suggestions.length === 0 ? (
          <Req ids={['R12.1']}>
            <p className="text-sm text-muted-foreground">Nothing waiting. New suggestions show up here after the next learning run.</p>
          </Req>
        ) : (
          <div className="space-y-3">
            {suggestions.map((rule) => <SuggestionCard key={rule.id} rule={rule} decision={decisions[rule.id]} onDecide={(decision) => onDecide(rule, decision)} onEdit={() => onEdit(rule)} onUndo={() => onUndo(rule)} onShow={() => onShow(rule)} />)}
          </div>
        )}
      </section>
    </Req>
  )
}

// ---------- Scope sections ----------

function GroupLabel({ children }: { children: ReactNode }) {
  return <p className="text-xs font-medium text-muted-foreground">{children}</p>
}

interface ScopeCounts { on: number; off: number; suggested: number; replaced: number }

/** One scope: Your rules (set or approved, by strength), a pointer to its suggestions, then the replaced chain (§14). */
function ScopeSection({ scope, rules, counts, approvedNow, highlighted, actions }: { scope: RuleScope; rules: OwnerRule[]; counts: ScopeCounts; approvedNow: Set<string>; highlighted: string | null; actions: RuleActions }) {
  const yours = rules.filter((rule) => rule.status === 'on' || rule.status === 'off').sort((a, b) => Number(a.status === 'off') - Number(b.status === 'off') || byStrength(a, b))
  const waiting = rules.filter((rule) => rule.status === 'suggested').sort(byStrength)
  const rejected = rules.filter((rule) => rule.status === 'dismissed')
  const replaced = rules.filter((rule) => rule.status === 'replaced').sort((a, b) => a.latestDaysAgo - b.latestDaysAgo)
  const tierLabel = RULE_TIERS.find((tier) => tier.tier === scope.tier)!.label
  return (
    <Req ids={['R14.5', 'R14.6', 'R14.7']}>
      <section id={`scope-${scope.id}`} className="scroll-mt-36 space-y-3 lg:scroll-mt-20">
        <header className="flex flex-wrap items-baseline justify-between gap-x-3 border-b pb-2">
          <div>
            {scope.tier !== 'everywhere' && <p className="text-xs text-muted-foreground">{tierLabel}</p>}
            <h2 className="text-base font-semibold">{scopeHeading(scope)}</h2>
          </div>
          <p className="text-xs text-muted-foreground">{counts.on} on{counts.off ? ` · ${counts.off} off` : ''}{counts.suggested ? ` · ${counts.suggested} suggested` : ''}</p>
        </header>

        {yours.length > 0 && (
          <div className="space-y-2">
            <GroupLabel>Your rules · strongest first</GroupLabel>
            <div className="divide-y rounded-xl border">
              {yours.map((rule) => <RuleBlock key={rule.id} rule={rule} replaces={rules.filter((other) => other.status === 'replaced' && chainReaches(rules, other, rule.id))} justApproved={approvedNow.has(rule.id)} highlighted={highlighted === rule.id} actions={actions} />)}
            </div>
          </div>
        )}
        {(waiting.length > 0 || rejected.length > 0) && (
          <div>
            <GroupLabel>Suggested · learned, not yours until you approve</GroupLabel>
            <SuggestedPointer waiting={waiting} rejected={rejected} />
          </div>
        )}
        {replaced.length > 0 && (
          <div className="space-y-2">
            <GroupLabel>Replaced · when rules conflict, the newer one wins</GroupLabel>
            <div className="divide-y rounded-xl border border-dashed">
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

function ScopeNav({ countsByScope, waiting }: { countsByScope: Map<string, ScopeCounts>; waiting: number }) {
  return (
    <Req ids={['R14.5']}>
      <nav className="space-y-3 text-sm" aria-label="Scopes">
        <button type="button" onClick={() => scrollToId('decide')} className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-muted">
          <span className="font-medium">Needs your decision</span>
          {waiting > 0 && <span className="rounded-full bg-attention px-1.5 text-[11px] font-medium text-attention-foreground">{waiting}</span>}
        </button>
        {RULE_TIERS.map(({ tier, label }) => (
          <div key={tier} className="space-y-0.5">
            {tier !== 'everywhere' && <p className="px-2 text-xs text-muted-foreground">{label}</p>}
            {RULE_SCOPES.filter((scope) => scope.tier === tier).map((scope) => {
              const counts = countsByScope.get(scope.id)!
              return (
                <button key={scope.id} type="button" onClick={() => scrollToId(`scope-${scope.id}`)} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted">
                  <span className="truncate">{scope.name}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {counts.suggested > 0 && <span className="text-review-foreground">{counts.suggested} new ·</span>}
                    {counts.on} on
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </nav>
    </Req>
  )
}

/** Mobile: the same jump list as a sticky, thumb-sized chip row under the app header (§11). */
function ScopeChips({ countsByScope, waiting }: { countsByScope: Map<string, ScopeCounts>; waiting: number }) {
  return (
    <Req ids={['R14.5', 'R11.1']} className="lg:hidden">
      <nav aria-label="Scopes" className="sticky top-16 z-20 -mx-4 flex gap-2 overflow-x-auto border-b bg-background/95 px-4 py-2 backdrop-blur [scrollbar-width:none] lg:hidden">
        {waiting > 0 && <button type="button" onClick={() => scrollToId('decide')} className="h-11 shrink-0 rounded-full border border-attention-border px-4 text-sm font-medium text-attention-foreground">Decide · {waiting}</button>}
        {RULE_SCOPES.map((scope) => (
          <button key={scope.id} type="button" onClick={() => scrollToId(`scope-${scope.id}`)} className="h-11 shrink-0 rounded-full border bg-card px-4 text-sm">
            {scope.name} <span className="text-muted-foreground">{countsByScope.get(scope.id)!.on}</span>
          </button>
        ))}
      </nav>
    </Req>
  )
}

/** The rules file as claude-mem would write it: approved rules only, grouped by the §14 hierarchy. */
function rulesFileLines(rules: OwnerRule[]) {
  const loaded = rules.filter((rule) => rule.status === 'on')
  return [{ text: '# My Rules', ruleId: null as string | null }, ...RULE_SCOPES.flatMap((scope) => {
    const inScope = loaded.filter((rule) => rule.scopeId === scope.id).sort(byStrength)
    return inScope.length ? [{ text: '', ruleId: null }, { text: `## ${scopeHeading(scope)}`, ruleId: null }, ...inScope.map((rule) => ({ text: `- When ${rule.when}: ${lowerFirst(rule.then)}`, ruleId: rule.id }))] : []
  })]
}

/** The Markdown file agents load (decision 7): approved rules only, user-level files only. Changes this session are marked. */
function AgentFile({ rules, changed, open, onOpenChange }: { rules: OwnerRule[]; changed: Set<string>; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { mode } = useWorkspace()
  const loaded = rules.filter((rule) => rule.status === 'on').length
  const lines = rulesFileLines(rules)
  return (
    <Req ids={['D7']}>
      <Artifact className="shadow-none">
        <ArtifactHeader className="flex-col items-start gap-2 bg-card">
          <ArtifactTitle className="flex items-center gap-1.5 font-mono text-xs"><FileTextIcon className="size-3.5" />{RULES_FILE}</ArtifactTitle>
          <ArtifactDescription className="text-xs">{loaded} rules you set or approved. claude-mem writes this file and loads it with your user-level instructions, never a project’s files.</ArtifactDescription>
          <Button variant="outline" size="sm" className="h-11 text-xs sm:h-8" onClick={() => onOpenChange(true)}>Preview file{changed.size > 0 && ` · ${changed.size} changed`}</Button>
        </ArtifactHeader>
      </Artifact>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{RULES_FILE}</DialogTitle>
            <DialogDescription>
              Rebuilt from the synced rule records, so every machine gets the same file{mode === 'web' ? ' once it pulls your web changes' : ''}. Claude Code imports it from ~/.claude/CLAUDE.md; Codex and Gemini get a marked block in ~/.codex/AGENTS.md and ~/.gemini/GEMINI.md. Suggested rules are not in it until you approve them.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60svh] overflow-auto rounded-lg border border-terminal-border bg-terminal p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-terminal-foreground">
            {lines.map((line, index) => (
              <span key={index} className={cn('block', line.ruleId && changed.has(line.ruleId) && 'bg-shipped/30')}>{line.text || ' '}{line.ruleId && changed.has(line.ruleId) && <span className="opacity-60">  ← changed just now</span>}</span>
            ))}
          </pre>
          <p className="text-xs text-muted-foreground">Wireframe: this preview is built from the page’s sample state; nothing is written to disk.</p>
        </DialogContent>
      </Dialog>
    </Req>
  )
}

/** Where an edit is saved from and how fresh every machine is (§13.5, §13.6). */
function WhereEditsGo() {
  const { mode } = useWorkspace()
  return (
    <Req ids={['R13.7', 'R13.8', 'R13.1']}>
      <div className="space-y-1.5 text-xs">
        <p className="font-medium">Your edits save {mode === 'web' ? 'from the web' : `on ${HERE.name}`}</p>
        <p className="text-muted-foreground">{mode === 'web' ? 'Written as a “web” device record. Every machine pulls it down on its next sync and rebuilds MY-RULES.md.' : 'MY-RULES.md is rebuilt here, then the change syncs to your other machines.'}</p>
        <ul className="space-y-0.5 text-muted-foreground">
          {SAMPLE_DEVICES.filter((device) => mode === 'web' || device.id !== HERE.id).map((device) => (
            <li key={device.id} className="flex items-center gap-1.5">
              <span className={cn('size-1.5 rounded-full', device.online ? 'bg-shipped-foreground' : 'bg-idle-foreground')} />
              {device.name}<span className="ml-auto">{device.syncedMinutesAgo === 0 ? 'synced now' : `synced ${device.syncedMinutesAgo} min ago`}</span>
            </li>
          ))}
        </ul>
      </div>
    </Req>
  )
}

/** What the last learning run read and found, where it ran, and how Refresh works here (§14). */
function LearningRun() {
  const { mode } = useWorkspace()
  return (
    <Req ids={['R14.10', 'R14.13', 'R7.3']}>
      <div className="space-y-1.5 text-xs">
        <p className="flex items-center gap-1.5 font-medium"><SparklesIcon className="size-3.5" />Last learning run</p>
        <p className="text-muted-foreground">{SAMPLE_RUNS.rules.lastRunAt} on {SAMPLE_DEVICES.find((device) => device.id === SAMPLE_RUNS.rules.deviceId)!.name}. Read {RULES_LEARNING.reviewsRead} request reviews and your latest goals run, found {RULES_LEARNING.newSuggestions} new suggestions.</p>
        <p className="text-muted-foreground">{mode === 'web' ? 'From the web, Refresh queues the run for the next machine online; it needs your local transcripts.' : 'Refresh runs on this machine’s worker, which reads your Claude Code and Codex transcripts.'}</p>
      </div>
    </Req>
  )
}

// ---------- Editor ----------

interface Draft { id: string | null; scopeId: string; when: string; then: string; approving: boolean }

/** Add, edit, or edit-then-approve a rule (§14: people set rules too). */
function RuleEditor({ draft, onChange, onClose, onSave }: { draft: Draft | null; onChange: (draft: Draft) => void; onClose: () => void; onSave: () => void }) {
  const { mode } = useWorkspace()
  return (
    <Req ids={['R14.9', 'R13.7']}>
      <Dialog open={draft !== null} onOpenChange={(open) => { if (!open) onClose() }}>
        {draft && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{draft.approving ? 'Edit, then approve' : draft.id ? 'Edit rule' : 'Add a rule'}</DialogTitle>
              <DialogDescription>Write it the way you’d say it. Saving puts it in MY-RULES.md, which loads with your user-level instructions from the next session.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1.5"><Label htmlFor="rule-scope">Applies</Label>
                <Select value={draft.scopeId} onValueChange={(scopeId) => onChange({ ...draft, scopeId })}>
                  <SelectTrigger id="rule-scope" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {RULE_TIERS.map(({ tier, label }) => (
                      <SelectGroup key={tier}>
                        <SelectLabel>{label}</SelectLabel>
                        {RULE_SCOPES.filter((scope) => scope.tier === tier).map((scope) => <SelectItem key={scope.id} value={scope.id}>{scope.name}</SelectItem>)}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5"><Label htmlFor="rule-when">When</Label><Input id="rule-when" value={draft.when} placeholder="you open a pull request" onChange={(event) => onChange({ ...draft, when: event.target.value })} /></div>
              <div className="grid gap-1.5"><Label htmlFor="rule-then">Then</Label><Textarea id="rule-then" value={draft.then} placeholder="Never open it as a draft." onChange={(event) => onChange({ ...draft, then: event.target.value })} /></div>
            </div>
            <DialogFooter className="items-center gap-3 sm:justify-between">
              <p className="text-xs text-muted-foreground">{mode === 'web' ? 'Saves from the web; every machine pulls it down.' : `Saves on ${HERE.name} and syncs to your other machines.`}</p>
              <Button className="h-11 sm:h-9" onClick={onSave} disabled={!draft.when.trim() || !draft.then.trim()}>{draft.approving ? 'Save and approve' : 'Save rule'}</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </Req>
  )
}

// ---------- Page ----------

interface RulesState {
  decisions: Record<string, Decision>
  toggles: Record<string, boolean>
  edits: Record<string, { scopeId: string; when: string; then: string }>
  added: OwnerRule[]
}
const EMPTY_STATE: RulesState = { decisions: {}, toggles: {}, edits: {}, added: [] }
interface Change { text: string; ruleId: string }

export function MyRules() {
  const { mode } = useWorkspace()
  const [state, setState] = useState<RulesState>(EMPTY_STATE)
  // Every change pushes the previous state, so the saved note's Undo reverses exactly the last change.
  const [history, setHistory] = useState<{ state: RulesState; change: Change | null }[]>([])
  const [lastChange, setLastChange] = useState<Change | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [fileOpen, setFileOpen] = useState(false)

  // The queue keeps its original learned rules so a decision can be undone in place.
  const suggestions = useMemo(() => OWNER_RULES.filter((rule) => rule.status === 'suggested').sort(byStrength), [])
  const rules = useMemo(() => [...OWNER_RULES, ...state.added].map((rule): OwnerRule => {
    const edited = state.edits[rule.id] ? { ...rule, ...state.edits[rule.id] } : rule
    const decision = state.decisions[rule.id]
    if (decision === 'approved') return { ...edited, setBy: 'approved', status: rule.id in state.toggles && !state.toggles[rule.id] ? 'off' : 'on' }
    if (decision === 'rejected') return { ...edited, status: 'dismissed' }
    if (rule.id in state.toggles) return { ...edited, status: state.toggles[rule.id] ? 'on' : 'off' }
    return edited
  }), [state])
  const waiting = suggestions.filter((rule) => !state.decisions[rule.id]).length
  const approvedNow = new Set(Object.entries(state.decisions).filter(([, decision]) => decision === 'approved').map(([id]) => id))
  const changed = new Set([
    ...approvedNow,
    ...Object.keys(state.edits), ...Object.keys(state.toggles), ...state.added.map((rule) => rule.id),
  ])

  const countsByScope = new Map(RULE_SCOPES.map((scope) => {
    const inScope = rules.filter((rule) => rule.scopeId === scope.id)
    const count = (status: OwnerRule['status']) => inScope.filter((rule) => rule.status === status).length
    return [scope.id, { on: count('on'), off: count('off'), suggested: count('suggested'), replaced: count('replaced') }]
  }))
  const onCount = rules.filter((rule) => rule.status === 'on').length

  const commit = (next: RulesState, change: Change) => {
    setHistory([...history, { state, change: lastChange }])
    setState(next)
    setLastChange(change)
  }
  const undoLast = () => {
    const previous = history.at(-1)
    if (!previous) return
    setState(previous.state)
    setHistory(history.slice(0, -1))
    setLastChange(previous.change)
  }
  const jump = (ruleId: string) => {
    scrollToId(`rule-${ruleId}`)
    setHighlighted(ruleId)
    setTimeout(() => setHighlighted(null), 1800)
  }
  const ruleName = (rule: OwnerRule) => `“${lowerFirst(rule.then).replace(/\.$/, '')}”`

  const decide = (rule: OwnerRule, decision: Decision) => commit({ ...state, decisions: { ...state.decisions, [rule.id]: decision } },
    { text: decision === 'approved' ? `Approved ${ruleName(rule)} under ${scopeHeading(scopeById(rule.scopeId))}` : `Rejected ${ruleName(rule)}`, ruleId: rule.id })
  const undoDecision = (rule: OwnerRule) => {
    const decisions = { ...state.decisions }
    delete decisions[rule.id]
    commit({ ...state, decisions }, { text: `Put ${ruleName(rule)} back in Needs your decision`, ruleId: rule.id })
  }
  const actions: RuleActions = {
    onToggle: (rule, on) => commit({ ...state, toggles: { ...state.toggles, [rule.id]: on } }, { text: `Turned ${on ? 'on' : 'off'} ${ruleName(rule)}`, ruleId: rule.id }),
    onEdit: (rule) => setDraft({ id: rule.id, scopeId: rule.scopeId, when: rule.when, then: rule.then, approving: false }),
    onJump: jump,
  }
  const saveDraft = () => {
    if (!draft) return
    if (draft.id) {
      const edits = { ...state.edits, [draft.id]: { scopeId: draft.scopeId, when: draft.when, then: draft.then } }
      const decisions = draft.approving ? { ...state.decisions, [draft.id]: 'approved' as const } : state.decisions
      commit({ ...state, edits, decisions }, { text: `${draft.approving ? 'Edited and approved' : 'Edited'} “${lowerFirst(draft.then).replace(/\.$/, '')}”`, ruleId: draft.id })
    } else {
      const rule: OwnerRule = { id: `added-${state.added.length}`, scopeId: draft.scopeId, setBy: 'owner', when: draft.when, then: draft.then, quotes: [], timesSeen: 1, latestAt: 'today', latestDaysAgo: 0, source: 'you', status: 'on', records: [{ kind: 'Instructions', label: `Written in My Rules${mode === 'web' ? ' on the web' : ` on ${HERE.name}`}`, at: 'today' }] }
      commit({ ...state, added: [...state.added, rule] }, { text: `Added ${ruleName(rule)} under ${scopeHeading(scopeById(rule.scopeId))}`, ruleId: rule.id })
    }
    setDraft(null)
  }

  return (
    <Req ids={['R4.6', 'R7.3']}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Req ids={['R12.3', 'R12.2', 'D7']}>
            <div className="max-w-2xl space-y-1">
              <p className="text-base leading-snug font-medium">
                {waiting > 0 ? <>{waiting} learned {waiting === 1 ? 'rule is' : 'rules are'} waiting for you. </> : <>Nothing is waiting for you. </>}
                {onCount} rules are on.
              </p>
              <p className="text-sm text-muted-foreground"><span className="hidden sm:inline">How you like to work, as if-then rules. </span>Rules you set or approve go in MY-RULES.md, loaded with your user-level instructions. Learned ones wait here until you decide.</p>
            </div>
          </Req>
          <div className="flex items-center gap-2">
            <Req ids={['R14.9']}><Button className="h-11 sm:h-8" size="sm" onClick={() => setDraft({ id: null, scopeId: 'everywhere', when: '', then: '', approving: false })}><PlusIcon />Add rule</Button></Req>
            <RefreshButton run={SAMPLE_RUNS.rules} ids={['R14.13']} />
            <Req ids={['R14.10', 'R11.1']}><span className="text-xs leading-tight text-muted-foreground sm:hidden">Last run {SAMPLE_RUNS.rules.lastRunAt.replace('Today, ', '')}<br />on {SAMPLE_DEVICES.find((device) => device.id === SAMPLE_RUNS.rules.deviceId)!.name}</span></Req>
          </div>
        </div>

        {lastChange && (
          <Req ids={['R13.7', 'D7']}>
            <div role="status" className="space-y-1 border-l-2 border-shipped-border py-1 pl-3 text-xs">
              <p className="flex items-start gap-1.5 font-medium text-shipped-foreground"><CheckIcon className="mt-px size-3.5 shrink-0" />{lastChange.text}.</p>
              <p className="text-muted-foreground">{savedWhere(mode)}. <span className="italic">Wireframe: not actually written.</span></p>
              <div className="-ml-2 flex flex-wrap">
                <Button variant="ghost" size="sm" className="h-11 text-xs sm:h-8" onClick={() => setFileOpen(true)}>View in MY-RULES.md</Button>
                {rules.some((rule) => rule.id === lastChange.ruleId && (rule.status === 'on' || rule.status === 'off')) && <Button variant="ghost" size="sm" className="h-11 text-xs sm:h-8" onClick={() => jump(lastChange.ruleId)}>Show the rule</Button>}
                <Button variant="ghost" size="sm" className="h-11 text-xs sm:h-8" onClick={undoLast} disabled={history.length === 0}>Undo</Button>
              </div>
            </div>
          </Req>
        )}

        <ScopeChips countsByScope={countsByScope} waiting={waiting} />

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="min-w-0 space-y-10">
            <DecisionQueue suggestions={suggestions} decisions={state.decisions} onDecide={decide} onUndo={undoDecision} onShow={(rule) => jump(rule.id)}
              onEdit={(rule) => setDraft({ id: rule.id, scopeId: rule.scopeId, when: rule.when, then: rule.then, approving: true })} />
            {RULE_SCOPES.map((scope) => (
              <ScopeSection key={scope.id} scope={scope} rules={rules.filter((rule) => rule.scopeId === scope.id)} counts={countsByScope.get(scope.id)!}
                approvedNow={approvedNow} highlighted={highlighted} actions={actions} />
            ))}
          </div>

          <aside className="space-y-6 lg:sticky lg:top-20 lg:self-start">
            <div className="hidden lg:block"><ScopeNav countsByScope={countsByScope} waiting={waiting} /></div>
            <AgentFile rules={rules} changed={changed} open={fileOpen} onOpenChange={setFileOpen} />
            <div className="space-y-6 rounded-xl border bg-card p-4">
              <WhereEditsGo />
              <LearningRun />
            </div>
          </aside>
        </div>

        <RuleEditor draft={draft} onChange={setDraft} onClose={() => setDraft(null)} onSave={saveDraft} />
      </div>
    </Req>
  )
}
