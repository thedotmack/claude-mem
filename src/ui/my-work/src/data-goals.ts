// Sample focus areas, their asks and Past focus (`?source=sample`; the sample source puts them in the WorkModel). The
// shape, counts and states follow a real owner-goals run and my-focus list; titles, quotes and links are neutral
// placeholders, so no one's real prompts ship in the sample. Area names never reuse a nav word.
import { isSampleHref, SAMPLE_REQUESTS, type CurrentPeriod, type FocusArea, type FocusAsk, type PastPeriod } from './data.ts'

/** Work product with no real target yet. The page shows these as sample, never as a link that looks real. */

const PR = (number: number) => `https://example.com/pull/${number}`
const SPEC_PAGE = 'https://example.com/pages/my-work-spec'
const WIREFRAME_PAGE = 'https://example.com/pages/my-work-wireframe'

// data.ts SAMPLE_REQUESTS stays the single source of request state; areas hold request ids through each request's
// focusAreaId and never copy requests. Where data.ts still carries a placeholder target for an artifact that really
// exists, fill in the real link once, on the shared object. No-op when data.ts already has a real href.
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

const area = (fields: Pick<FocusArea, 'id' | 'name' | 'goal' | 'status' | 'source'> & Partial<FocusArea>): FocusArea => ({
  ownerRank: null, priorityRank: null, mergedInto: null, evidence: null, timesAsked: null, latestAt: null, quotes: [], asks: [], ...fields,
})
const ask = (fields: FocusAsk) => fields

/** The my-focus list, as the worker sends it: kept areas in the owner's order, then suggestions, then one done. */
export const SAMPLE_FOCUS_AREAS: FocusArea[] = [
  area({ id: 'fa-viewer', name: 'Viewer', goal: 'Ship My Work LIVE as claude-mem 14.', status: 'kept', source: 'owner-goals', ownerRank: 1, priorityRank: 1, timesAsked: 4, latestAt: '10-18 22:11',
    quotes: [
      { at: '10-18 22:11', quote: 'this is the most important thing right now, please get it shipped' },
      { at: '10-17 00:51', quote: 'release this tonight as the next full release' },
      { at: '10-16 09:39', quote: 'i love the card view, lets keep it + the list view too with sorting added' },
    ],
    asks: [ask({ id: 'a-live', title: 'A real live indicator on cards', timesAsked: 2, latestAt: '10-17 06:40', quotes: [{ at: '10-17 06:40', quote: 'i still cannot tell which cards are live right now' }] })] }),
  area({ id: 'fa-sync', name: 'Cloud sync', goal: 'Make cloud sync dependable for everyone.', status: 'kept', source: 'owner-goals', ownerRank: 2, priorityRank: 5, timesAsked: 3, latestAt: '10-15 22:51',
    quotes: [
      { at: '10-15 22:51', quote: 'use the real rollup data we already have, not a simulated forecast' },
      { at: '10-15 20:49', quote: 'what i need to know is whether sync is healthy for everyone' },
    ],
    asks: [ask({ id: 'a-panel', title: 'Cloud sync health panel from real data', timesAsked: 4, latestAt: '10-16 02:04', quotes: [{ at: '10-16 02:04', quote: 'show what this looks like at real scale' }] })] }),
  area({ id: 'fa-search', name: 'Search', goal: 'Restore the three-step search and ship the quick mode.', status: 'kept', source: 'owner-goals', ownerRank: 3, priorityRank: 2, timesAsked: 3, latestAt: '10-18 22:09',
    quotes: [{ at: '10-18 22:09', quote: 'why is the quick mode still not shipped?' }, { at: '10-13 12:21', quote: 'go ahead and restore the search, and rename the quick mode' }] }),
  area({ id: 'fa-behavior', name: 'Agent behavior', goal: 'Agents follow how you like to work, and rules stay easy to change.', status: 'kept', source: 'owner-goals', ownerRank: 4, priorityRank: 3, timesAsked: 4, latestAt: '10-18 22:06',
    quotes: [{ at: '10-18 22:06', quote: 'please stop writing rules that can never change' }],
    asks: [ask({ id: 'a-permanent', title: 'Stop writing rules that can never change', timesAsked: 1, latestAt: '10-18 22:06', quotes: [{ at: '10-18 22:06', quote: 'if i change my mind later, a permanent rule means you will never listen to me' }] })] }),
  area({ id: 'fa-decks', name: 'Reports and decks', goal: 'Decks and reports that answer your real question.', status: 'suggested', source: 'owner-goals', priorityRank: 9, timesAsked: 4, latestAt: '10-17 09:40',
    quotes: [{ at: '10-17 07:36', quote: 'i care less about how many tests pass than what changed' }, { at: '10-15 13:45', quote: 'show me the decisions i actually have to make' }],
    asks: [ask({ id: 'a-decks', title: 'Slide decks: drop the upload, download and waiting', timesAsked: 5, latestAt: '10-17 09:40', quotes: [{ at: '10-17 09:40', quote: "remove the upload step ... and just have it make the deck and that's it" }, { at: '10-17 09:38', quote: "i've asked before" }] })] }),
  area({ id: 'fa-team', name: 'Team workspaces', goal: 'A self-serve team plan and a page at the quality bar.', status: 'suggested', source: 'seed', priorityRank: 4,
    evidence: 'Set up from how your requests were sorted before the areas existed.' }),
  area({ id: 'fa-growth', name: 'Growth', goal: 'Community updates, the homepage and a launch event.', status: 'suggested', source: 'clustering',
    evidence: 'Requests in Other read as steps of something larger.' }),
  area({ id: 'fa-fixes', name: 'Plugin fixes', goal: 'Small plugin fixes you kept asking for again.', status: 'done', source: 'owner-goals', priorityRank: 8, timesAsked: 3, latestAt: '10-16 19:18',
    quotes: [{ at: '10-16 19:18', quote: 'please fix it' }] }),
]

/** Asks the run could not place in an area. They show under Other. */
export const SAMPLE_OTHER_ASKS: FocusAsk[] = [
  ask({ id: 'a-side', title: 'Side project traction', timesAsked: 2, latestAt: '10-18 21:54', quotes: [{ at: '10-18 21:54', quote: 'any new stars, issues or PRs?' }] }),
]

/** The current owner-goals run (Past focus shows its time and machine from SAMPLE_RUNS.goals). */
export const SAMPLE_CURRENT_PERIOD: CurrentPeriod = { label: 'Sep 18 – Oct 18', windowDays: 31, promptCount: 823 }

/** Saved past months (owner-goals/<start>), newest first. Their asks are archived with the month. */
export const SAMPLE_PAST_PERIODS: PastPeriod[] = [
  { id: '2026-08-18', label: 'Aug 18 – Sep 17', promptCount: 541,
    headline: 'You kept the plugin shipping, finished the paid plan and held running costs down.',
    areas: [
      { title: 'A long-running agent harness you can use yourself', label: 'Agent harness', timesAsked: 3, quote: { at: '09-15 10:04', quote: 'show me the harness web view now' } },
      { title: 'Agents do exactly what was asked and nothing extra', label: 'Agent behavior', timesAsked: 3, quote: { at: '09-16 10:37', quote: 'extra work that was not asked for still costs time' } },
      { title: 'Cheapest model that does the job well', label: 'Running costs', timesAsked: 4, quote: { at: '09-12 10:42', quote: 'use the tools we already have credits for' } },
    ] },
  { id: '2026-07-18', label: 'Jul 18 – Aug 17', promptCount: 703,
    headline: 'You took the paid plan from never launched to its first real customers.',
    areas: [
      { title: 'Paid plan core loop: sign up, get a key, it works', label: 'Paid plan', timesAsked: 5, quote: { at: '08-16 12:00', quote: 'find the PR that has the free trial links and make sure they are all in there' } },
      { title: 'Reliability and clear failure messages', label: 'Observer', timesAsked: 4, quote: { at: '08-16 10:10', quote: 'all errors should be well explained, with ways to get it resolved' } },
      { title: 'Key and usage limits done right', label: 'Paid plan', timesAsked: 6, quote: { at: '08-16 11:18', quote: 'leave my key uncapped for now, we can add a limit later' } },
    ] },
  { id: '2026-06-18', label: 'Jun 18 – Jul 17', promptCount: 962,
    headline: 'You pushed the hosted version toward launch while keeping the free plugin from breaking.',
    areas: [
      { title: 'Get the hosted version ready to launch', label: 'Hosted', timesAsked: 3, quote: { at: '07-12 21:05', quote: 'this needs to be ready for people to use soon' } },
      { title: 'One search backend with clear running costs', label: 'Hosted', timesAsked: 3, quote: { at: '07-13 12:16', quote: 'use one database for this, not three' } },
      { title: 'Real-time sync across devices, built right', label: 'Cloud sync', timesAsked: 2, quote: { at: '07-17 20:12', quote: 'we are trying to get to optimal architecture' } },
    ] },
  { id: '2026-05-18', label: 'May 18 – Jun 17', promptCount: 1469,
    headline: 'You made the plugin dependable for everyone who installs it.',
    areas: [
      { title: 'The worker reliably records memory for everyone', label: 'Plugin', timesAsked: 6, quote: { at: '06-12 18:08', quote: 'and everyone who installs it gets this right?' } },
      { title: 'Autonomous execution through to production', label: 'Agent behavior', timesAsked: 3, quote: { at: '06-13 13:36', quote: "don't ask me questions, just plan it and do it" } },
      { title: 'Cloud sync and team spaces', label: 'Hosted', timesAsked: 3, quote: { at: '06-11 23:38', quote: "i don't want 5 min sync, i want instant sync, that's very important." } },
    ] },
  { id: '2026-04-18', label: 'Apr 18 – May 17', promptCount: 2649,
    headline: 'You stripped workarounds out of the worker so it just works.',
    areas: [
      { title: 'Cloud sync and hosted spaces for teams', label: 'Cloud sync', timesAsked: 8, quote: { at: '05-17 16:20', quote: 'i want to offer this as a hosted service for devs and teams' } },
      { title: 'Radical simplicity: no workarounds, gates, timers or retries', label: 'Plugin', timesAsked: 61, quote: { at: '05-05 02:01', quote: 'why is there a limit here in the first place?' } },
      { title: 'Follow instructions literally and invoke named skills', label: 'Agent behavior', timesAsked: 12, quote: { at: '05-17 17:42', quote: 'and invoke skill implicitly always please.' } },
    ] },
  { id: '2026-03-18', label: 'Mar 18 – Apr 17', promptCount: 671,
    headline: 'You hardened and shipped the plugin: the installer, worktree memory, and a revert of an overbuilt change.',
    areas: [
      { title: 'Memory capture must just work', label: 'Plugin', timesAsked: 3, quote: { at: '04-16 14:53', quote: 'this is far more complicated than it needs to be' } },
      { title: 'Worktree-aware memory', label: 'Plugin', timesAsked: 6, quote: { at: '04-17 23:50', quote: 'every new worktree is running extra hooks' } },
      { title: 'Root-cause minimal fixes; revert overengineering', label: 'Agent behavior', timesAsked: 3, quote: { at: '04-16 14:25', quote: 'fix the root cause and keep the change small' } },
    ] },
]
