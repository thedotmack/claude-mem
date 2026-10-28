import { describe, expect, it } from 'bun:test';
import { buildOwnerGoals } from '../../src/services/work-view/agent-view.mjs';
import { reduceWorkState } from '../../src/services/work-view/data-source.mjs';

const generatedAt = '2026-10-23T15:05:00.000Z';
const summary = 'Full summary with line breaks.\n'.repeat(100);
const title = 'Ship the entire named deliverable. '.repeat(12);
const mapPath = `/workspace/${'subfolder/'.repeat(50)}owner-map.md`;
const evidence = [{ at: '2026-10-23 08:05', quote: 'Preserve this first line.\n  And the second line exactly.' }];
const listFields = { source: 'hosted-intent', generated_at: generatedAt, hosted_generated_at: generatedAt,
  human_summary: summary, map_path: mapPath, status: 'open' };
const taskFields = { task: `Focus area: ${title}`, title, status: 'todo', goal_kind: 'focus-area', rank: 1,
  source: 'hosted-intent', snapshot: generatedAt, hosted_snapshot: generatedAt,
  evidence: '2026-10-23 08:05 | legacy representation', evidence_json: JSON.stringify(evidence) };
const view = (later: Array<Record<string, unknown>> = []) => buildOwnerGoals(reduceWorkState(
  [listFields, taskFields, ...later].map((fields, index) => ({ id: index + 1, project: 'home', list_name: 'owner-goals',
    fields: JSON.stringify(fields), created_at_epoch: Date.parse(generatedAt) + index })),
  { currentProject: 'home', currentProjectScope: ['home'] },
));

describe('hosted goals in the work-view snapshot', () => {
  it('preserves complete text and multiline evidence from the hosted response', () => {
    const goals = view();
    expect(goals.summary).toBe(summary);
    expect(goals.mapPath).toBe(mapPath);
    expect(goals.areas[0]).toMatchObject({ kind: 'focus-area', title, evidence });
  });

  it('uses fresh local evidence after a later local refresh replaces the hosted snapshot', () => {
    const localGeneratedAt = '2026-10-24T15:05:00.000Z';
    const goals = view([{ generated_at: localGeneratedAt, human_summary: 'Updated local summary.' },
      { task: taskFields.task, snapshot: localGeneratedAt, title: 'Updated local goal.',
        evidence: '2026-10-24 08:05 | New local evidence.' }]);
    expect(goals.summary).toBe('Updated local summary.');
    expect(goals.areas[0]).toMatchObject({ title: 'Updated local goal.',
      evidence: [{ at: '2026-10-24 08:05', quote: 'New local evidence.' }] });
  });

  it('fails visibly instead of silently replacing malformed hosted evidence', () => {
    expect(() => view([{ task: taskFields.task, evidence_json: '{broken' }])).toThrow();
  });
});
