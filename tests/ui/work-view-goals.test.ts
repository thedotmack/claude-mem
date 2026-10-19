import { describe, expect, it } from 'bun:test';
import { buildAgentView } from '../../src/services/work-view/agent-view.mjs';
import { reduceWorkState } from '../../src/services/work-view/data-source.mjs';
import { goalsPanel } from '../../src/ui/work-view/request-views.js';

const NOW = Date.parse('2026-10-18T23:40:00Z');
let nextId = 1;
const entry = (list: string, fields: Record<string, unknown>, at = NOW) => ({ id: nextId++, project: 'home', list_name: list, fields: JSON.stringify(fields), created_at_epoch: at });
const viewFor = (entries: ReturnType<typeof entry>[]) => buildAgentView(reduceWorkState(entries, { currentProject: 'home', currentProjectScope: ['home'] }), {}, { now: NOW });

const snapshot = [
  entry('owner-goals', { human_summary: 'Trying to ship My Work.', generated_at: '2026-10-18T23:30:24-07:00', window_days: 31, source_prompt_count: 823 }),
  entry('owner-goals', { task: 'Priority: Restore mem-search', status: 'todo', goal_kind: 'priority', rank: 2, title: 'Restore mem-search', product: 'mem-search', latest_at: '2026-10-18 22:09', times_asked: 3, evidence: '2026-10-18 22:09 | WHY THE FLASH MODE ISNT SHIPPED' }),
  entry('owner-goals', { task: 'Priority: Ship My Work', status: 'todo', goal_kind: 'priority', rank: 1, title: 'Ship My Work', product: 'My Work', latest_at: '2026-10-18 22:11', times_asked: 4, evidence: '2026-10-18 22:11 | NOT SHIPPING\n2026-10-17 06:40 | that never got done <b>' }),
  entry('owner-goals', { task: 'Open ask: Hook timeout fix', status: 'todo', goal_kind: 'open-ask', rank: 9, title: 'Hook timeout fix', times_asked: 3, evidence: '2026-10-16 19:17 | fix it lol' }),
  entry('release', { task: 'publish', status: 'doing', progress: 'Building.' }),
];

describe('owner goals in My Work', () => {
  it('projects the owner-goals list as ranked Goals with parsed evidence, not as request cards', () => {
    const view = viewFor(snapshot);
    expect(view.goals.summary).toBe('Trying to ship My Work.');
    expect(view.goals.sourcePromptCount).toBe(823);
    expect(view.goals.priorities.map((item: { title: string }) => item.title)).toEqual(['Ship My Work', 'Restore mem-search']);
    expect(view.goals.priorities[0].evidence).toEqual([{ at: '2026-10-18 22:11', quote: 'NOT SHIPPING' }, { at: '2026-10-17 06:40', quote: 'that never got done <b>' }]);
    expect(view.goals.openAsks.map((item: { task: string }) => item.task)).toEqual(['Open ask: Hook timeout fix']);
    const work = view.agents.flatMap((agent: { work: { listName?: string }[] }) => agent.work);
    expect(work.some((item) => item.listName === 'owner-goals')).toBe(false);
    expect(work.some((item) => item.listName === 'release')).toBe(true);
  });

  it('drops items a newer snapshot closed, and has no Goals without the list', () => {
    const view = viewFor([...snapshot, entry('owner-goals', { task: 'Priority: Restore mem-search', status: 'dropped' }, NOW + 1)]);
    expect(view.goals.priorities.map((item: { title: string }) => item.title)).toEqual(['Ship My Work']);
    expect(viewFor([entry('release', { task: 'publish', status: 'doing' })]).goals).toBeNull();
  });

  it('renders priorities and open asks with expandable, escaped evidence', () => {
    const html = goalsPanel(viewFor(snapshot).goals);
    expect(html).toContain('<h2 id="goals-heading">Goals</h2>');
    expect(html).toContain('Last 31 days · 823 prompts you typed');
    expect(html).toContain('Top priorities');
    expect(html).toContain('Open asks');
    expect(html).toContain('Evidence · 2 quotes');
    expect(html).toContain('<time>2026-10-17 06:40</time><q>that never got done &lt;b&gt;</q>');
    expect(html).toContain('My Work · Latest 2026-10-18 22:11 · Asked 4×');
    expect(html.indexOf('Ship My Work')).toBeLessThan(html.indexOf('Restore mem-search'));
    expect(goalsPanel(null)).toBe('');
  });

  it('folds open asks past the first few into a disclosure', () => {
    const goals = { priorities: [], openAsks: Array.from({ length: 12 }, (_, index) => ({ id: `a${index}`, rank: index + 1, title: `Ask ${index + 1}`, evidence: [] })) };
    const html = goalsPanel(goals);
    expect(html).toContain('2 more open asks');
    expect(html.indexOf('Ask 11')).toBeGreaterThan(html.indexOf('2 more open asks'));
  });
});
