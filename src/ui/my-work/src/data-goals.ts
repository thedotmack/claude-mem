// Sample data for the My Goals page only (`?source=sample`; the sample source puts it in the WorkModel). The shape, counts and states follow a real owner-goals run;
// titles, quotes and links are neutral placeholders, so no one's real prompts ship in the sample.
import { isSampleHref, SAMPLE_REQUESTS, type CurrentPeriod, type GoalItem, type PastPeriod, type Request } from './data.ts'

/** Work product with no real target yet. The page shows these as sample, never as a link that looks real. */

const PR = (number: number) => `https://example.com/pull/${number}`
const SPEC_PAGE = 'https://example.com/pages/my-work-spec'
const WIREFRAME_PAGE = 'https://example.com/pages/my-work-wireframe'

// data.ts SAMPLE_REQUESTS stays the single source of request state; Goals reads those objects by id and never copies them.
// Where data.ts still carries a placeholder target for an artifact that really exists, fill in the real link once,
// on the shared object, so My Work and My Goals show the same link. No-op when data.ts already has a real href.
const REAL_TARGETS: Record<string, Record<string, string>> = {
  r1: { 'My Work LIVE spec': SPEC_PAGE },
  r3: { '#343 store vectors in their own table': PR(343) },
  r4: { '#330 live human-request monitor': PR(330) },
}
for (const request of SAMPLE_REQUESTS) {
  for (const product of request.workProduct) {
    const real = REAL_TARGETS[request.id]?.[product.label]
    if (real && isSampleHref(product.href)) product.href = real
  }
}
const r1 = SAMPLE_REQUESTS.find((request) => request.id === 'r1')
if (r1 && !r1.workProduct.some((product) => product.href === WIREFRAME_PAGE)) r1.workProduct.push({ kind: 'Page', label: 'My Work wireframe', href: WIREFRAME_PAGE })

const emptyRequest = { activityWord: '', workstreams: [], granular: [], conversations: [], prompts: [], workProduct: [], followUps: [], story: [], evidence: [], terminal: [] }

/** Overall requests that serve goals but are not in today's My Work inbox (older, shipped or stalled). */
export const SAMPLE_GOAL_ONLY_REQUESTS: Request[] = [
  {
    ...emptyRequest,
    id: 'r6', title: 'Three-step search: stress test, ship and restore', summary: 'Bring back the three-step search and give the quick mode a clearer name.',
    goalId: 'g-search', askedBy: 'Alex', agentId: 'claude', startedAt: 'Oct 8, 10:24 am', runningFor: '12 days', stage: 'Reviewing', state: 'your-move',
    progress: { percent: 85, readings: 3, reviewedAt: 'Oct 19' }, estimate: 'at this pace, about Oct 22',
    next: { who: 'human', text: 'Approve the quick-search rename' },
    prompts: [{ at: '10-13 12:21', quote: 'go ahead and restore the search, and rename the quick mode' }],
    workProduct: [{ kind: 'PR', label: '#321 Smart three-step recall by default', href: PR(321) }, { kind: 'Deck', label: 'How search evolved', href: '#' }],
    story: [
      { label: 'Old 3-step skill compared with today’s', description: 'Found where auto mode drifted', status: 'complete' },
      { label: 'Stress test on real projects', description: 'Search, timeline, then records', status: 'complete' },
      { label: 'Rename the quick mode', description: 'Waiting on your approval', status: 'active' },
    ],
    evidence: [{ title: 'Observation: 3-step search restored on the branch', href: '#' }],
  },
  {
    ...emptyRequest,
    id: 'r7', title: 'Design-partner outreach for team workspaces', summary: 'Find the teams that would try it first and who to talk to.',
    goalId: 'g-team', askedBy: 'Alex', agentId: 'codex', startedAt: 'Oct 5, 9:12 am', runningFor: '10 days', stage: 'Shipped', state: 'shipped',
    progress: { percent: 100, readings: 4, reviewedAt: 'Oct 16', completedAt: 'Oct 15' }, estimate: null,
    next: { who: 'human', text: 'Pick the first design partner' },
    prompts: [{ at: '10-14 22:23', quote: 'start with the teams that already asked about this' }],
    workProduct: [{ kind: 'Deck', label: 'Interested teams overview', href: '#' }, { kind: 'Page', label: 'Design-partner shortlist', href: '#' }],
    followUps: [{ tag: 'Promo', text: 'Outreach emails to the shortlist', done: false }, { tag: 'Docs', text: 'How the shortlist was built', done: true }],
  },
  {
    ...emptyRequest,
    id: 'r8', title: 'Live panels for throughput and sync health', summary: 'Live panels so sync health is visible without asking.',
    goalId: 'g2', askedBy: 'Alex', agentId: 'gemini', startedAt: 'Oct 11, 4:40 pm', runningFor: '9 days', stage: 'Building', state: 'idle',
    progress: { percent: 85, readings: 2, reviewedAt: 'Oct 17' }, estimate: null,
    next: { who: 'bot', text: 'Wire the sync panel to real rollups' },
    workProduct: [{ kind: 'Page', label: 'Throughput panel', href: '#' }],
  },
  {
    ...emptyRequest,
    id: 'r12', title: 'Fix the UserPromptSubmit session-init hook timeout', summary: 'The 8 second hook timeout still fires on some machines.',
    goalId: 'g-fixes', askedBy: 'Alex', agentId: 'claude', startedAt: 'Oct 13, 8:48 am', runningFor: '7 days', stage: 'Building', state: 'idle',
    progress: { percent: 80, readings: 2, reviewedAt: 'Oct 17' }, estimate: null,
    next: { who: 'human', text: 'Decide: retry the fix or drop it' },
  },
  {
    ...emptyRequest,
    id: 'r13', title: 'Codex gets the observation timeline after compact', summary: 'Codex sessions see recent memory again after a compact.',
    goalId: 'g-fixes', askedBy: 'Alex', agentId: 'codex', startedAt: 'Oct 13, 8:47 am', runningFor: '1 day', stage: 'Shipped', state: 'shipped',
    progress: { percent: 100, readings: 3, reviewedAt: 'Oct 14', completedAt: 'Oct 13' }, estimate: null,
    next: { who: 'bot', text: 'Confirm what Codex sees after compact' },
    workProduct: [{ kind: 'PR', label: 'Inject the timeline after compact', href: '#' }],
  },
  {
    ...emptyRequest,
    id: 'r9', title: 'Fix the sign-in redirect loop', summary: 'Fixed the loop and told the people it locked out.',
    goalId: null, askedBy: 'Alex', agentId: 'claude', startedAt: 'Oct 13, 12:34 pm', runningFor: '1 day', stage: 'Shipped', state: 'shipped',
    progress: { percent: 100, readings: 2, reviewedAt: 'Oct 14', completedAt: 'Oct 14' }, estimate: null,
    next: { who: 'bot', text: '' },
    workProduct: [{ kind: 'PR', label: '#322 stop the start page bouncing to sign-in', href: PR(322) }],
    followUps: [{ tag: 'Promo', text: '“We fixed it” email', done: true }],
  },
  {
    ...emptyRequest,
    id: 'r10', title: 'Usage infographic', summary: 'One image that shows where the tool gets used.',
    goalId: null, askedBy: 'Alex', agentId: 'gemini', startedAt: 'Oct 14, 8:06 pm', runningFor: '1 day', stage: 'Shipped', state: 'shipped',
    progress: { percent: 100, readings: 1, reviewedAt: 'Oct 15', completedAt: 'Oct 15' }, estimate: null,
    next: { who: 'bot', text: '' },
    workProduct: [{ kind: 'Page', label: 'Usage infographic', href: '#' }],
  },
]

export const SAMPLE_PRIORITIES: GoalItem[] = [
  { id: 'g1', kind: 'Priority', title: 'Ship My Work LIVE as claude-mem 14', rank: 1, product: 'My Work', latestAt: '10-18 22:11', timesAsked: 4,
    quotes: [
      { at: '10-18 22:11', quote: 'this is the most important thing right now, please get it shipped' },
      { at: '10-17 00:51', quote: 'release this tonight as the next full release' },
      { at: '10-16 09:39', quote: 'i love the card view, lets keep it + the list view too with sorting added' },
    ] },
  { id: 'g-search', kind: 'Priority', rank: 2, title: 'Restore the three-step search and ship the quick mode', product: 'Search', latestAt: '10-18 22:09', timesAsked: 3,
    quotes: [
      { at: '10-18 22:09', quote: 'why is the quick mode still not shipped?' },
      { at: '10-13 12:21', quote: 'go ahead and restore the search, and rename the quick mode' },
      { at: '10-13 10:24', quote: 'my instinct is that we give it a clearer name' },
    ] },
  { id: 'g-rules', kind: 'Priority', rank: 3, title: 'Keep rules in skills, plans and instructions easy to change', product: 'Agent behavior', latestAt: '10-18 22:06', timesAsked: 4,
    quotes: [
      { at: '10-18 22:06', quote: 'please stop writing rules that can never change' },
      { at: '10-15 13:56', quote: 'say what to do instead of listing what not to do' },
      { at: '10-09 17:32', quote: 'that instruction says the opposite of what i meant' },
    ] },
  { id: 'g-team', kind: 'Priority', rank: 4, title: 'Team workspaces: a self-serve team plan and a page at the quality bar', product: 'Teams', latestAt: '10-17 06:49', timesAsked: 4,
    quotes: [
      { at: '10-17 06:41', quote: 'this needs to be much better than the first draft' },
      { at: '10-17 01:01', quote: 'self serve where you can sign up on the site as a team ... get checkout ready' },
      { at: '10-15 21:29', quote: 'keep the team version private for now' },
    ] },
  { id: 'g2', kind: 'Priority', title: 'Make cloud sync dependable', rank: 5, product: 'Cloud sync', latestAt: '10-15 22:51', timesAsked: 3,
    quotes: [
      { at: '10-15 22:51', quote: 'use the real rollup data we already have, not a simulated forecast' },
      { at: '10-15 20:49', quote: 'what i need to know is whether sync is healthy for everyone' },
      { at: '10-04 15:51', quote: 'sync is what lets people keep a fast local copy' },
    ] },
  { id: 'g-cost', kind: 'Priority', rank: 6, title: 'Keep running costs low without hardcoded workarounds', product: 'Running costs', latestAt: '10-06 15:22', timesAsked: 3,
    quotes: [{ at: '10-06 15:22', quote: 'which change caused the spike?' }, { at: '10-03 22:32', quote: 'that setting belongs in the provider dashboard' }] },
  { id: 'g-auto', kind: 'Priority', rank: 7, title: 'Full autonomy: agents use the tools they have, the browser and subagents, and do releases', product: 'Agent behavior', latestAt: '10-16 18:22', timesAsked: 4,
    quotes: [{ at: '10-14 22:06', quote: 'use the key that is already set up' }, { at: '10-05 09:59', quote: 'you can publish this yourself, the release skill covers it' }] },
  { id: 'g-fixes', kind: 'Priority', rank: 8, title: 'Small plugin fixes you keep re-asking for', product: 'Plugin', latestAt: '10-16 19:18', timesAsked: 3,
    quotes: [{ at: '10-16 19:18', quote: 'what is confirmed for what the agent sees on new chats and after compact?' }, { at: '10-16 19:17', quote: 'please fix it' }] },
  { id: 'g-decks', kind: 'Priority', rank: 9, title: 'Decks and reports that answer your real question', product: 'Reports & decks', latestAt: '10-17 09:40', timesAsked: 4,
    quotes: [{ at: '10-17 07:36', quote: 'i care less about how many tests pass than what changed' }, { at: '10-15 13:45', quote: 'show me the decisions i actually have to make' }] },
  { id: 'g-growth', kind: 'Priority', rank: 10, title: 'Growth: community updates, the homepage and a launch event', product: 'Growth', latestAt: '10-18 21:54', timesAsked: 3,
    quotes: [{ at: '10-18 21:54', quote: 'any new stars, issues or PRs?' }, { at: '10-14 19:56', quote: 'the invite should say come see the demo live' }] },
]

export const SAMPLE_OPEN_ASKS: GoalItem[] = [
  { id: 'a-wooow', kind: 'Open ask', rank: 1, title: 'Slide decks: drop the upload, download and waiting', product: 'Reports & decks', latestAt: '10-17 09:40', timesAsked: 5,
    quotes: [{ at: '10-17 09:40', quote: "remove the upload step ... and just have it make the deck and that's it" }, { at: '10-17 09:38', quote: "i've asked before" }, { at: '10-02 09:47', quote: 'does nothing after creating the deck' }] },
  { id: 'g3', kind: 'Open ask', title: 'A real live indicator on cards', rank: 2, product: 'My Work', latestAt: '10-17 06:40', timesAsked: 2,
    quotes: [{ at: '10-17 06:40', quote: 'i still cannot tell which cards are live right now' }] },
  { id: 'a-dario', kind: 'Open ask', rank: 3, title: 'Side project traction', product: 'Side project', latestAt: '10-18 21:54', timesAsked: 2,
    quotes: [{ at: '10-18 21:54', quote: 'any new stars, issues or PRs?' }, { at: '10-16 18:05', quote: 'by end of night we should have 10 stars' }] },
  { id: 'a-hook', kind: 'Open ask', rank: 4, title: 'Hook timeout fix (UserPromptSubmit 8s)', product: 'Plugin', latestAt: '10-16 19:17', timesAsked: 3, servedBy: ['r12'],
    quotes: [{ at: '10-16 19:17', quote: 'please fix it' }, { at: '10-13 13:03', quote: 'was this fixed?' }] },
  { id: 'a-codex', kind: 'Open ask', rank: 5, title: 'Codex timeline after compact', product: 'Plugin', latestAt: '10-16 19:18', timesAsked: 4, servedBy: ['r13'],
    quotes: [{ at: '10-16 19:18', quote: 'what is confirmed for what the agent sees on new chats and after compact?' }, { at: '10-13 08:47', quote: 'does codex see a timeline?' }] },
  { id: 'a-panel', kind: 'Open ask', rank: 6, title: 'Cloud sync health panel from real data', product: 'Cloud sync', latestAt: '10-16 02:04', timesAsked: 4, servedBy: ['r2'],
    quotes: [{ at: '10-16 02:04', quote: 'show what this looks like at real scale' }] },
  { id: 'a-permanent', kind: 'Open ask', rank: 7, title: 'Stop writing rules that can never change', product: 'Agent behavior', latestAt: '10-18 22:06', timesAsked: 1,
    quotes: [{ at: '10-18 22:06', quote: 'if i change my mind later, a permanent rule means you will never listen to me' }] },
]

/** The current owner-goals run (the Refresh button shows its time and machine from SAMPLE_RUNS.goals). */
export const SAMPLE_CURRENT_PERIOD: CurrentPeriod = { label: 'Sep 18 – Oct 18', windowDays: 31, promptCount: 823 }

/** Saved past months (owner-goals/<start>), newest first. Their asks are archived with the month. */
export const SAMPLE_PAST_PERIODS: PastPeriod[] = [
  { id: '2026-08-18', label: 'Aug 18 – Sep 17', promptCount: 541,
    headline: 'You kept the plugin shipping, finished the paid plan and held running costs down.',
    priorities: [
      { title: 'A long-running agent harness you can use yourself', product: 'Agent harness', timesAsked: 3, quote: { at: '09-15 10:04', quote: 'show me the harness web view now' } },
      { title: 'Agents do exactly what was asked and nothing extra', product: 'Agent behavior', timesAsked: 3, quote: { at: '09-16 10:37', quote: 'extra work that was not asked for still costs time' } },
      { title: 'Cheapest model that does the job well', product: 'Running costs', timesAsked: 4, quote: { at: '09-12 10:42', quote: 'use the tools we already have credits for' } },
    ] },
  { id: '2026-07-18', label: 'Jul 18 – Aug 17', promptCount: 703,
    headline: 'You took the paid plan from never launched to its first real customers.',
    priorities: [
      { title: 'Paid plan core loop: sign up, get a key, it works', product: 'Paid plan', timesAsked: 5, quote: { at: '08-16 12:00', quote: 'find the PR that has the free trial links and make sure they are all in there' } },
      { title: 'Reliability and clear failure messages', product: 'Observer', timesAsked: 4, quote: { at: '08-16 10:10', quote: 'all errors should be well explained, with ways to get it resolved' } },
      { title: 'Key and usage limits done right', product: 'Paid plan', timesAsked: 6, quote: { at: '08-16 11:18', quote: 'leave my key uncapped for now, we can add a limit later' } },
    ] },
  { id: '2026-06-18', label: 'Jun 18 – Jul 17', promptCount: 962,
    headline: 'You pushed the hosted version toward launch while keeping the free plugin from breaking.',
    priorities: [
      { title: 'Get the hosted version ready to launch', product: 'Hosted', timesAsked: 3, quote: { at: '07-12 21:05', quote: 'this needs to be ready for people to use soon' } },
      { title: 'One search backend with clear running costs', product: 'Hosted', timesAsked: 3, quote: { at: '07-13 12:16', quote: 'use one database for this, not three' } },
      { title: 'Real-time sync across devices, built right', product: 'Cloud sync', timesAsked: 2, quote: { at: '07-17 20:12', quote: 'we are trying to get to optimal architecture' } },
    ] },
  { id: '2026-05-18', label: 'May 18 – Jun 17', promptCount: 1469,
    headline: 'You made the plugin dependable for everyone who installs it.',
    priorities: [
      { title: 'The worker reliably records memory for everyone', product: 'Plugin', timesAsked: 6, quote: { at: '06-12 18:08', quote: 'and everyone who installs it gets this right?' } },
      { title: 'Autonomous execution through to production', product: 'Agent behavior', timesAsked: 3, quote: { at: '06-13 13:36', quote: "don't ask me questions, just plan it and do it" } },
      { title: 'Cloud sync and team spaces', product: 'Hosted', timesAsked: 3, quote: { at: '06-11 23:38', quote: "i don't want 5 min sync, i want instant sync, that's very important." } },
    ] },
  { id: '2026-04-18', label: 'Apr 18 – May 17', promptCount: 2649,
    headline: 'You stripped workarounds out of the worker so it just works.',
    priorities: [
      { title: 'Cloud sync and hosted spaces for teams', product: 'Cloud sync', timesAsked: 8, quote: { at: '05-17 16:20', quote: 'i want to offer this as a hosted service for devs and teams' } },
      { title: 'Radical simplicity: no workarounds, gates, timers or retries', product: 'Plugin', timesAsked: 61, quote: { at: '05-05 02:01', quote: 'why is there a limit here in the first place?' } },
      { title: 'Follow instructions literally and invoke named skills', product: 'Agent behavior', timesAsked: 12, quote: { at: '05-17 17:42', quote: 'and invoke skill implicitly always please.' } },
    ] },
  { id: '2026-03-18', label: 'Mar 18 – Apr 17', promptCount: 671,
    headline: 'You hardened and shipped the plugin: the installer, worktree memory, and a revert of an overbuilt change.',
    priorities: [
      { title: 'Memory capture must just work', product: 'Plugin', timesAsked: 3, quote: { at: '04-16 14:53', quote: 'this is far more complicated than it needs to be' } },
      { title: 'Worktree-aware memory', product: 'Plugin', timesAsked: 6, quote: { at: '04-17 23:50', quote: 'every new worktree is running extra hooks' } },
      { title: 'Root-cause minimal fixes; revert overengineering', product: 'Agent behavior', timesAsked: 3, quote: { at: '04-16 14:25', quote: 'fix the root cause and keep the change small' } },
    ] },
]
