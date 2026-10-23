// Sample data for the My Rules wireframe only (spec §14). The product shows real rule records or an empty state (§12).
// Examples are neutral placeholders shaped like real standing preferences from instruction files and prompts.

/** Scope hierarchy, in page order (§14): everywhere, then per product or project, then per situation. */
export type RuleTier = 'everywhere' | 'project' | 'situation'
export interface RuleScope { id: string; tier: RuleTier; name: string }

export const RULE_TIERS: { tier: RuleTier; label: string }[] = [
  { tier: 'everywhere', label: 'Everywhere' },
  { tier: 'project', label: 'In a product or project' },
  { tier: 'situation', label: 'In a situation' },
]

export const SAMPLE_RULE_SCOPES: RuleScope[] = [
  { id: 'everywhere', tier: 'everywhere', name: 'Everywhere' },
  { id: 'cmem-cloud', tier: 'project', name: 'Hosted app' },
  { id: 'claude-mem', tier: 'project', name: 'claude-mem' },
  { id: 'frustrated', tier: 'situation', name: 'When I’m frustrated' },
  { id: 'designs', tier: 'situation', name: 'When reviewing designs' },
]

/** A dated quote. `kind` is the request-progress preference kind; instruction-file lines are directives. */
export interface RuleQuote { at: string; quote: string; kind: 'directive' | 'correction' | 'praise' | 'frustration'; where: 'prompt' | 'CLAUDE.md' }
/** The records a rule was built from: prompts, request-progress reviews, owner-goals runs, instruction files. */
export interface RuleRecord { kind: 'Prompt' | 'Review' | 'Goals run' | 'Instructions'; label: string; at: string }

export type RuleStatus = 'on' | 'off' | 'suggested' | 'replaced' | 'dismissed'
export interface OwnerRule {
  id: string
  scopeId: string
  /** Who set it (§14): written by the owner, learned then approved, or only learned so far. */
  setBy: 'owner' | 'approved' | 'learned'
  when: string
  then: string
  quotes: RuleQuote[]
  timesSeen: number
  latestAt: string
  /** For the strength sort: times seen × recency (§14). */
  latestDaysAgo: number
  source: 'request-progress' | 'owner-goals' | 'you'
  status: RuleStatus
  replacedBy?: { ruleId: string; at: string }
  records: RuleRecord[]
}

export const SAMPLE_OWNER_RULES: OwnerRule[] = [
  // Everywhere
  { id: 'autonomy', scopeId: 'everywhere', setBy: 'owner', when: 'my directive is clear', then: 'Execute it. Don’t follow up with a question.', timesSeen: 11, latestAt: 'Oct 20', latestDaysAgo: 0, source: 'you', status: 'on',
    quotes: [
      { at: 'CLAUDE.md', where: 'CLAUDE.md', kind: 'directive', quote: 'When the ask is clear, do it instead of asking me to confirm.' },
      { at: 'CLAUDE.md', where: 'CLAUDE.md', kind: 'directive', quote: 'You can make routine approvals for me along the way.' },
    ],
    records: [{ kind: 'Instructions', label: 'CLAUDE.md · Autonomy', at: 'Oct 9' }, { kind: 'Review', label: 'request-progress · 7 requests showed it', at: 'Oct 20' }] },
  { id: 'no-draft-pr', scopeId: 'everywhere', setBy: 'owner', when: 'you open a pull request', then: 'Never open it as a draft.', timesSeen: 6, latestAt: 'Oct 18', latestDaysAgo: 2, source: 'you', status: 'on',
    quotes: [{ at: 'CLAUDE.md', where: 'CLAUDE.md', kind: 'directive', quote: 'Open pull requests ready for review, not as drafts.' }],
    records: [{ kind: 'Instructions', label: 'CLAUDE.md · Pull requests', at: 'Oct 9' }] },
  { id: 'no-plan-pr', scopeId: 'everywhere', setBy: 'owner', when: 'the work is a plan, research, spec or notes', then: 'Keep it in a gitignored folder. Never open a PR for it.', timesSeen: 4, latestAt: 'Oct 19', latestDaysAgo: 1, source: 'you', status: 'on',
    quotes: [{ at: 'CLAUDE.md', where: 'CLAUDE.md', kind: 'directive', quote: 'Plans and notes stay out of pull requests.' }],
    records: [{ kind: 'Instructions', label: 'CLAUDE.md · Pull requests', at: 'Oct 9' }] },
  { id: 'no-tmp', scopeId: 'everywhere', setBy: 'owner', when: 'you write scratch or temporary files', then: 'Keep them inside the project, in .scratch/. Never use /tmp.', timesSeen: 5, latestAt: 'Oct 20', latestDaysAgo: 0, source: 'you', status: 'on',
    quotes: [{ at: 'CLAUDE.md', where: 'CLAUDE.md', kind: 'directive', quote: 'Keep scratch files inside the project so they can be reviewed.' }],
    records: [{ kind: 'Instructions', label: 'CLAUDE.md · File locations', at: 'Oct 9' }] },
  { id: 'decide-not-counts', scopeId: 'everywhere', setBy: 'approved', when: 'you report results', then: 'Lead with what I need to decide, not raw counts.', timesSeen: 6, latestAt: 'Oct 17', latestDaysAgo: 3, source: 'request-progress', status: 'on',
    quotes: [
      { at: 'Oct 17, 7:36 am', where: 'prompt', kind: 'frustration', quote: 'i care less about how many tests pass than what changed' },
      { at: 'Oct 14, 10:28 pm', where: 'prompt', kind: 'directive', quote: 'tell me what I need to know first' },
    ],
    records: [{ kind: 'Review', label: 'request-progress · “Admin price page” review', at: 'Oct 17' }, { kind: 'Prompt', label: 'Claude Code · hosted app', at: 'Oct 17, 7:36 am' }] },
  { id: 'done-ping', scopeId: 'everywhere', setBy: 'approved', when: 'a long background run finishes', then: 'Send me a done-ping.', timesSeen: 2, latestAt: 'Oct 12', latestDaysAgo: 8, source: 'owner-goals', status: 'off',
    quotes: [{ at: 'Oct 12, 9:14 pm', where: 'prompt', kind: 'directive', quote: 'let me know when it finishes' }],
    records: [{ kind: 'Goals run', label: 'owner-goals · “How they want work done”', at: 'Oct 18' }] },
  { id: 'real-data', scopeId: 'everywhere', setBy: 'learned', when: 'you show numbers', then: 'Use the real rollup data. Leave it empty rather than simulate or forecast.', timesSeen: 4, latestAt: 'Oct 19', latestDaysAgo: 1, source: 'request-progress', status: 'suggested',
    quotes: [
      { at: 'Oct 15, 10:51 pm', where: 'prompt', kind: 'frustration', quote: 'use the real rollup data we already have, not a simulated forecast' },
      { at: 'Oct 19, 1:12 am', where: 'prompt', kind: 'directive', quote: 'pull the key number out of the data and explain it plainly' },
    ],
    records: [{ kind: 'Review', label: 'request-progress · 4 requests showed it', at: 'Oct 20, 1:50 pm' }, { kind: 'Prompt', label: 'Claude Code · usage forecast', at: 'Oct 15, 10:51 pm' }] },

  // Hosted app: a replaced-rule chain stays visible (follow the latest model, then a pinned release, then a scheduled cheapest pick).
  { id: 'model-cron', scopeId: 'cmem-cloud', setBy: 'owner', when: 'choosing the shared observer model', then: 'Let the scheduled check pick the cheapest suitable model. A manual choice lasts until the next check.', timesSeen: 3, latestAt: 'Oct 11', latestDaysAgo: 9, source: 'you', status: 'on',
    quotes: [{ at: 'Oct 11 · CLAUDE.md', where: 'CLAUDE.md', kind: 'directive', quote: 'pick the lowest-priced suitable model on each scheduled check' }],
    records: [{ kind: 'Instructions', label: 'Project CLAUDE.md · Model policy', at: 'Oct 11' }, { kind: 'Prompt', label: 'Claude Code · model check', at: 'Oct 11' }] },
  { id: 'model-0731', scopeId: 'cmem-cloud', setBy: 'owner', when: 'choosing the shared observer model', then: 'Pin one specific model release.', timesSeen: 2, latestAt: 'Oct 9', latestDaysAgo: 11, source: 'you', status: 'replaced', replacedBy: { ruleId: 'model-cron', at: 'Oct 11' },
    quotes: [{ at: 'Oct 9 · CLAUDE.md', where: 'CLAUDE.md', kind: 'correction', quote: 'use this one release for now instead of always following the latest' }],
    records: [{ kind: 'Instructions', label: 'Project CLAUDE.md · Pinned release', at: 'Oct 9' }] },
  { id: 'model-latest', scopeId: 'cmem-cloud', setBy: 'owner', when: 'choosing the shared observer model', then: 'Always follow the latest model release.', timesSeen: 3, latestAt: 'Oct 2', latestDaysAgo: 18, source: 'you', status: 'replaced', replacedBy: { ruleId: 'model-0731', at: 'Oct 9' },
    quotes: [{ at: 'Oct 2 · CLAUDE.md', where: 'CLAUDE.md', kind: 'directive', quote: 'always follow the latest release automatically' }],
    records: [{ kind: 'Instructions', label: 'Project CLAUDE.md · Latest model', at: 'Oct 2' }] },
  { id: 'top-up', scopeId: 'cmem-cloud', setBy: 'owner', when: 'the provider balance runs out', then: 'Top up credits instead of rerouting traffic.', timesSeen: 2, latestAt: 'Oct 4', latestDaysAgo: 16, source: 'you', status: 'on',
    quotes: [{ at: 'Oct 4 · CLAUDE.md', where: 'CLAUDE.md', kind: 'correction', quote: 'An empty balance is fixed by topping up, not by changing the routing.' }],
    records: [{ kind: 'Instructions', label: 'Project CLAUDE.md · Provider rule', at: 'Oct 4' }] },
  { id: 'pr-after-push', scopeId: 'cmem-cloud', setBy: 'owner', when: 'you push a finished change to a feature branch', then: 'Open a PR to main right away.', timesSeen: 3, latestAt: 'Oct 16', latestDaysAgo: 4, source: 'you', status: 'on',
    quotes: [{ at: 'CLAUDE.md', where: 'CLAUDE.md', kind: 'directive', quote: 'Open the pull request as soon as the branch is pushed.' }],
    records: [{ kind: 'Instructions', label: 'Project CLAUDE.md', at: 'Oct 9' }] },
  { id: 'money', scopeId: 'cmem-cloud', setBy: 'learned', when: 'you report on cloud sync', then: 'Say first whether sync is healthy for everyone.', timesSeen: 3, latestAt: 'Oct 15', latestDaysAgo: 5, source: 'owner-goals', status: 'suggested',
    quotes: [{ at: 'Oct 15, 8:49 pm', where: 'prompt', kind: 'directive', quote: 'what i need to know is whether sync is healthy for everyone' }],
    records: [{ kind: 'Goals run', label: 'owner-goals · “Make cloud sync dependable”', at: 'Oct 20, 11:02 am' }] },

  // claude-mem
  { id: 'mockups-first', scopeId: 'claude-mem', setBy: 'approved', when: 'you design a screen', then: 'Generate image mockups with the UI Redesign skill before writing code.', timesSeen: 5, latestAt: 'Oct 19', latestDaysAgo: 1, source: 'request-progress', status: 'on',
    quotes: [
      { at: 'Oct 19, 9:45 am', where: 'prompt', kind: 'correction', quote: 'make image mockups first, not HTML edits' },
      { at: 'Oct 13, 3:29 pm', where: 'prompt', kind: 'directive', quote: 'still just generated mockups until i say code' },
    ],
    records: [{ kind: 'Review', label: 'request-progress · “Top-layer mockups” review', at: 'Oct 19' }] },
  { id: 'ui-kit', scopeId: 'claude-mem', setBy: 'owner', when: 'you build a live interactive UI', then: 'Build it in React on a real UI kit, never plain HTML.', timesSeen: 4, latestAt: 'Oct 17', latestDaysAgo: 3, source: 'you', status: 'on',
    quotes: [
      { at: 'Oct 17, 8:25 am', where: 'prompt', kind: 'directive', quote: 'i want it done with a ui kit' },
      { at: 'Oct 17, 2:25 pm', where: 'prompt', kind: 'correction', quote: 'the react version we already agreed to' },
    ],
    records: [{ kind: 'Prompt', label: 'Claude Code · work monitor', at: 'Oct 17, 8:23 am' }] },
  { id: 'codex-design', scopeId: 'claude-mem', setBy: 'learned', when: 'a design pass is needed', then: 'Have Codex run it, with the UI Redesign skill actually loaded.', timesSeen: 2, latestAt: 'Oct 20', latestDaysAgo: 0, source: 'request-progress', status: 'suggested',
    quotes: [
      { at: 'Oct 19, 11:11 am', where: 'prompt', kind: 'correction', quote: 'i wanted Codex to run this design pass' },
      { at: 'Oct 20, 11:08 am', where: 'prompt', kind: 'frustration', quote: 'doesn’t feel like it has the ‘ui redesign’ skill applied to it' },
    ],
    records: [{ kind: 'Review', label: 'request-progress · “Goals redesign” review', at: 'Oct 20, 1:50 pm' }] },

  // Situations
  { id: 'frustrated', scopeId: 'frustrated', setBy: 'owner', when: 'I’m frustrated or cursing', then: 'Stop. Write out what you think I want, ask “Is this it? Yes, no, or modify?”, and do nothing else until I answer.', timesSeen: 3, latestAt: 'Oct 20', latestDaysAgo: 0, source: 'you', status: 'on',
    quotes: [{ at: 'CLAUDE.md', where: 'CLAUDE.md', kind: 'directive', quote: 'when I sound frustrated, pause and confirm what I want before going on' }],
    records: [{ kind: 'Instructions', label: 'CLAUDE.md · Frustration check', at: 'Oct 9' }] },
  { id: 'keep-liked', scopeId: 'designs', setBy: 'approved', when: 'I say I like where a design is', then: 'Don’t redesign it. Push it to git and save it.', timesSeen: 2, latestAt: 'Oct 16', latestDaysAgo: 4, source: 'request-progress', status: 'on',
    quotes: [{ at: 'Oct 16, 1:42 am', where: 'prompt', kind: 'praise', quote: 'i like where this is at so push this stuff to git and save it' }],
    records: [{ kind: 'Review', label: 'request-progress · “Work monitor cards” review', at: 'Oct 16' }] },
]

/** What the last learning run (request-progress) read and found. */
export interface RulesLearning { preferencesFound: number; newSuggestions: number; reviewsRead: number }
export const SAMPLE_RULES_LEARNING: RulesLearning = { preferencesFound: 14, newSuggestions: 3, reviewsRead: 23 }

/** The file agents load: approved rules only. `loadedInClaudeCode`: the user-level CLAUDE.md (`instructionsPath`) imports it. */
export interface RulesFile { path: string; instructionsPath?: string; approvedCount: number; loadedInClaudeCode: boolean }

/** One saved change to My Rules (POST /api/work-view/rules). */
export interface RuleDraft { scopeTier: RuleTier; scopeName: string; when: string; then: string }
export interface RuleChange {
  action: 'approve' | 'edit' | 'turn-off' | 'turn-on' | 'dismiss' | 'add' | 'replace' | 'restore-suggestion'
  ruleId?: string
  rule?: RuleDraft
}
