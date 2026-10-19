import { describe, expect, it } from 'bun:test';
import { goalSignals, goalsPanel } from '../../src/ui/work-view/request-views.js';

const goal = (id: string, fields: Record<string, unknown> = {}) => ({
  id, title: id, rank: 1, status: 'todo', evidence: [], ...fields,
});

describe('Goals communicates what the recorded signals mean', () => {
  it('counts repeated open asks without counting the same subject again as a priority', () => {
    const signals = goalSignals({
      priorities: [goal('priority', { title: 'Ship My Work', timesAsked: 4 })],
      openAsks: [
        goal('ask-repeated', { title: 'Ship My Work', timesAsked: 4 }),
        goal('ask-once', { timesAsked: 1 }),
        goal('ask-unknown'),
        goal('ask-zero', { timesAsked: 0 }),
      ],
    });

    expect(signals.priorities).toHaveLength(1);
    expect(signals.openAsks).toHaveLength(4);
    expect(signals.repeatedAsks.map((item: { id: string }) => item.id)).toEqual(['ask-repeated']);
  });

  it('treats the first-ranked priority as focus rather than a completion or productivity score', () => {
    const first = goal('Ship My Work', { rank: 1, timesAsked: 4 });
    const goals = {
      listName: 'owner-goals', history: false,
      priorities: [first, goal('Make cloud sync profitable', { rank: 2 })],
      openAsks: [goal('Finish the launch')],
    };
    const signals = goalSignals(goals);
    const html = goalsPanel(goals);

    expect(signals.lead).toEqual(first);
    expect(signals.lead.status).toBe('todo');
    expect(signals).not.toHaveProperty('score');
    expect(signals).not.toHaveProperty('completionRate');
    expect(html).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
    expect(html).not.toMatch(/\b\d+\s*\/\s*100\b/);
  });

  it('keeps archived asks as historical asks when their storage status is done', () => {
    const history = {
      listName: 'owner-goals/2026-08-18', history: true,
      periodStart: '2026-08-18', periodEnd: '2026-09-18',
      priorities: [goal('Keep claude-mem reliable', { status: 'done' })],
      openAsks: [goal('Fix worker startup', { status: 'done', timesAsked: 3 })],
    };
    const signals = goalSignals(history);
    const html = goalsPanel(null, { history: [history], selected: history.listName });

    expect(signals.openAsks).toHaveLength(1);
    expect(signals.repeatedAsks).toHaveLength(1);
    expect(html).toContain('Open asks then');
    expect(html).toMatch(/[Hh]istory/);
    expect(html).not.toMatch(/\b100\s*%/);
    expect(html).not.toMatch(/\b(?:all goals complete|all asks resolved|goals achieved)\b/i);
  });
});
