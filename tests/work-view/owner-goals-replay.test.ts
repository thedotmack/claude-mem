/**
 * Replays the 23 owner-goals items the live refresh saved on 2026-10-26 (8 priorities and 15 open asks, before
 * the three tests) through the save path: save_goals.py against the worker's own routes and reducers.
 * The classification is the model's job, so the answer below is a stub: each live item, put through the three
 * tests by hand, with the item's own recorded quotes. Plan expectation: 5 areas, 13 asks and 4 rules, plus one
 * item split into an area and a rule.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeOwnerGoalsWorker } from '../helpers/fake-owner-goals-worker.js';
import { scratchDir } from '../helpers/scratch-dir.js';

interface LiveItem { task: string; title: string; rank: number; latest_at: string; times_asked: number; evidence: string }
const fixture = JSON.parse(readFileSync(join(import.meta.dir, '..', 'fixtures', 'owner-goals', 'live-2026-10-26.json'), 'utf8')) as { listState: Record<string, unknown>; items: LiveItem[] };
const quotesOf = (item: LiveItem) => item.evidence.split('\n').map((line) => { const [at, ...words] = line.split(' | '); return { at, quote: words.join(' | ') }; });
const item = (task: string) => {
  const found = fixture.items.find((entry) => entry.task === task);
  if (!found) throw new Error(`No live item ${task}`);
  return found;
};

type Area = { kind: 'area'; title: string; goal: string };
type Ask = { kind: 'ask'; focusArea: string | null };
type Rule = { kind: 'rule'; when: string; then: string };
type Part = (Area | Ask | Rule) & { quotes?: number[] };
/** The stubbed answer: every live item through the three tests (rule? ask? area?), in that order. */
const SORTED: Record<string, Part[]> = {
  'Priority: Ship the My Work / My Goals / My Rules live GUI': [{ kind: 'area', title: 'Viewer', goal: 'My Work shows every request I made, grouped the way I think about it, with live progress.' }],
  'Priority: Put generated deliverables directly on viewer cards': [{ kind: 'ask', focusArea: 'Viewer' }],
  'Priority: Community sweep and contributor growth': [{ kind: 'area', title: 'Community', goal: 'Grow the claude-mem contributor community and keep its pull requests moving.' }],
  'Priority: Endless Mode: infinite agent via durable header cache + growing timeline': [{ kind: 'area', title: 'Endless Mode', goal: 'An agent that runs forever on a durable header cache and a growing timeline.' }],
  // Two parts: a part of the work (releases) and how it is done (without the owner publishing).
  'Priority: Ship everything end to end without the owner publishing': [
    { kind: 'area', title: 'Releases', goal: 'Releases and their announcements go out end to end.', quotes: [1, 2] },
    { kind: 'rule', when: 'work is approved', then: 'Carry it through release, posts included, without the owner publishing anything.', quotes: [0, 3] },
  ],
  'Priority: TeamBrain self-serve growth toward a revenue goal': [{ kind: 'area', title: 'TeamBrain', goal: 'TeamBrain grows self-serve toward its revenue goal.' }],
  'Priority: Transcript-scan onboarding funnel into Local vs Cloud': [{ kind: 'area', title: 'Onboarding', goal: 'The install funnel scans transcripts and leads people into Local or Cloud.' }],
  'Priority: Design quality through Codex UI Redesign image-gen passes': [{ kind: 'rule', when: 'generating images or designs with a subagent', then: 'Give it a plain, generic prompt and let it use its own creativity; check the logo is right.' }],
  'Open ask: Release intent-based grouping to everyone with JEV for [a plan]': [{ kind: 'ask', focusArea: 'Viewer' }],
  'Open ask: Copy deliverables into project buckets and link them on cards': [{ kind: 'ask', focusArea: 'Viewer' }],
  'Open ask: Install and verify PostHog for viewer usage': [{ kind: 'ask', focusArea: 'Viewer' }],
  "Open ask: Investigate [a contributor]'s app and other projects": [{ kind: 'ask', focusArea: 'Community' }],
  'Open ask: Review older PRs against current initiatives and gate experiments': [{ kind: 'ask', focusArea: 'Community' }],
  'Open ask: Build and backtest the Endless Mode timeline design': [{ kind: 'ask', focusArea: 'Endless Mode' }],
  'Open ask: Post the 15.1.0 X posts (My Work, My Goals, My Rules) with correct images': [{ kind: 'ask', focusArea: 'Releases' }],
  'Open ask: TeamBrain free for GitHub-logged-in claude-mem contributors': [{ kind: 'ask', focusArea: 'TeamBrain' }],
  'Open ask: Make the viewer live with Zustand state management': [{ kind: 'ask', focusArea: 'Viewer' }],
  "Open ask: Follow the owner's stated design instead of searching": [{ kind: 'rule', when: 'the owner has already said how they want something', then: 'Build it the way they said instead of searching or re-deriving it.' }],
  'Open ask: Make the last30days skill work correctly for claude-mem': [{ kind: 'ask', focusArea: 'Community' }],
  'Open ask: Stop slow scans and worktree/test sprawl': [{ kind: 'rule', when: 'scanning, testing or making worktrees', then: 'Avoid slow full scans and clean up worktrees and test files instead of letting them pile up.' }],
  'Open ask: Fix the Gemini refresh failure': [{ kind: 'ask', focusArea: 'Viewer' }],
  'Open ask: Side experiment later: replace tool calls with one-sentence summaries': [{ kind: 'ask', focusArea: 'Endless Mode' }],
  'Open ask: Plain, unleading subagent prompts': [{ kind: 'rule', when: 'briefing a subagent', then: 'Write a plain prompt that does not lead it toward an answer.' }],
};

/** The goals JSON a model would answer for the live items, built from the stub and the items' own quotes. */
function stubbedAnswer(matches: Record<string, string> = {}) {
  const answer = { generated_at: '2026-10-26T14:46:25-07:00', window_days: 31, source_prompt_count: 1083, human_summary: String(fixture.listState.human_summary),
    focus_areas: [] as unknown[], asks: [] as unknown[], rules: [] as unknown[] };
  let areaRank = 0, askRank = 0;
  for (const live of fixture.items) {
    const parts = SORTED[live.task];
    if (!parts) throw new Error(`The stub does not sort ${live.task}`);
    for (const part of parts) {
      const all = quotesOf(live);
      const evidence = part.quotes ? part.quotes.map((index) => all[index]) : all;
      const common = { latest_at: evidence[0].at, times_asked: part.quotes ? evidence.length : live.times_asked, evidence };
      if (part.kind === 'area') answer.focus_areas.push({ rank: ++areaRank, title: part.title, goal: part.goal, matches: matches[part.title] ?? null, ...common });
      else if (part.kind === 'ask') answer.asks.push({ rank: ++askRank, title: live.title, focus_area: part.focusArea, ...common });
      else answer.rules.push({ when: part.when, then: part.then, ...common });
    }
  }
  return answer;
}

/** owner-prompts.md holding exactly the recorded quotes, each under the minute it was typed. */
function promptsFile() {
  const byMinute = new Map<string, string[]>();
  for (const live of fixture.items) for (const quote of quotesOf(live)) byMinute.set(quote.at, [...(byMinute.get(quote.at) ?? []), quote.quote]);
  return `# Owner prompts\n\n${[...byMinute].sort(([a], [b]) => a.localeCompare(b)).map(([minute, words]) => `## ${minute} · claude · repo\nsession \`a\`\n\n${words.join('\n\n')}\n`).join('\n---\n\n')}`;
}

describe('owner-goals replay of the live 2026-10-26 items', () => {
  it('the fixture holds the 23 live items: 8 priorities and 15 open asks, each sorted by the stub', () => {
    expect(fixture.items).toHaveLength(23);
    expect(fixture.items.filter((entry) => entry.task.startsWith('Priority: '))).toHaveLength(8);
    expect(fixture.items.filter((entry) => entry.task.startsWith('Open ask: '))).toHaveLength(15);
    expect(Object.keys(SORTED).sort()).toEqual(fixture.items.map((entry) => entry.task).sort());
  });

  it('saves 5 areas, 13 asks and 4 rules, plus 1 item split into an area and a rule; a second run never overrides the owner', async () => {
    const dir = scratchDir('owner-goals-replay');
    const worker = fakeOwnerGoalsWorker(join(dir, 'data'));
    try {
      const ledgerDir = join(dir, 'ledger');
      mkdirSync(ledgerDir);
      writeFileSync(join(dir, 'owner-prompts.md'), promptsFile());
      const save = async (answer: unknown) => {
        writeFileSync(join(dir, 'goals.json'), JSON.stringify(answer));
        const result = await worker.run(['--goals', join(dir, 'goals.json'), '--prompts', join(dir, 'owner-prompts.md'), '--ledger-dir', ledgerDir]);
        expect(result.stderr).toBe('');
        expect(result.exitCode).toBe(0);
        return JSON.parse(result.stdout);
      };

      const first = await save(stubbedAnswer());
      expect(first).toMatchObject({ saved_focus_areas: 6, saved_asks: 13, saved_rules: 5, new_focus_areas: 6, unlinked_asks: [] });
      const split = Object.entries(SORTED).filter(([, parts]) => parts.length > 1);
      expect(split.map(([task, parts]) => [task, parts.map((part) => part.kind)])).toEqual([['Priority: Ship everything end to end without the owner publishing', ['area', 'rule']]]);
      const single = Object.values(SORTED).filter((parts) => parts.length === 1).map(([part]) => part.kind);
      expect([single.filter((kind) => kind === 'area').length, single.filter((kind) => kind === 'ask').length, single.filter((kind) => kind === 'rule').length]).toEqual([5, 13, 4]);

      const goals = worker.state().lists.find((list: { name: string }) => list.name === 'owner-goals').tasks.filter((task: { isOpen: boolean }) => task.isOpen);
      const kinds = goals.map((task: { fields: { goal_kind: string } }) => task.fields.goal_kind);
      expect([kinds.filter((kind: string) => kind === 'focus-area').length, kinds.filter((kind: string) => kind === 'ask').length]).toEqual([6, 13]);
      expect(kinds.every((kind: string) => kind === 'focus-area' || kind === 'ask')).toBe(true);
      const areas = worker.focusAreas();
      expect(areas.map((area) => [area.name, area.status, area.source, area.priorityRank]))
        .toEqual([['Viewer', 'suggested', 'owner-goals', 1], ['Community', 'suggested', 'owner-goals', 2], ['Endless Mode', 'suggested', 'owner-goals', 3],
          ['Releases', 'suggested', 'owner-goals', 4], ['TeamBrain', 'suggested', 'owner-goals', 5], ['Onboarding', 'suggested', 'owner-goals', 6]]);
      // Every ask names its area's id; none fits no area.
      const idByName = new Map(areas.map((area) => [area.name, area.focusAreaId]));
      for (const ask of goals.filter((task: { fields: { goal_kind: string } }) => task.fields.goal_kind === 'ask')) {
        expect(ask.fields.focus_area_id).toBe(idByName.get(ask.fields.focus_area));
      }
      const story = JSON.parse(readFileSync(join(ledgerDir, 'story.json'), 'utf8'));
      expect(story.preferences).toHaveLength(5);
      expect(story.preferences.every((preference: { source: string }) => preference.source === 'owner-goals')).toBe(true);

      // The owner keeps and renames Viewer and dismisses TeamBrain. The next run matches every area to its saved id
      // and moves Onboarding up: the owner's areas stay as the owner left them, the undecided suggestion is re-ranked.
      const byName = (name: string) => worker.focusAreas().find((area) => area.name === name)!;
      worker.ownerDecides(byName('Viewer'), { name: 'My Work viewer', status: 'kept' });
      worker.ownerDecides(byName('TeamBrain'), { status: 'dismissed' });
      const again = stubbedAnswer(Object.fromEntries(areas.map((area) => [area.name, area.focusAreaId])));
      for (const area of again.focus_areas as Array<{ title: string; rank: number }>) {
        area.rank = area.title === 'Onboarding' ? 1 : area.title === 'Viewer' ? 6 : area.rank + 1;
      }
      const second = await save(again);
      expect(second).toMatchObject({ saved_focus_areas: 6, new_focus_areas: 0, dropped_previous_items: 0 });
      const after = new Map(worker.focusAreas().map((area) => [area.focusAreaId, area]));
      expect(after.size).toBe(6);
      expect(after.get(idByName.get('Viewer')!)).toMatchObject({ name: 'My Work viewer', status: 'kept', priorityRank: 1, decidedBy: 'owner' });
      expect(after.get(idByName.get('TeamBrain')!)).toMatchObject({ status: 'dismissed', priorityRank: 5, decidedBy: 'owner' });
      expect(after.get(idByName.get('Onboarding')!)).toMatchObject({ status: 'suggested', priorityRank: 1, decidedBy: 'system' });
    } finally {
      worker.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
