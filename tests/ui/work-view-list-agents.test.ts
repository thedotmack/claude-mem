import { describe, expect, it } from 'bun:test';
import { agentCards, requestList } from '../../src/ui/work-view/request-views.js';

const agent = { id: 'reviewer/1', label: 'Reviewer', agentType: 'reviewer' };
const state = { view: 'list', range: 'week', sort: 'title', query: 'layout', project: 'one', filter: 'all' };
const row = { id: 'request/1', title: 'Review layout', status: 'ready', project: 'one', projects: ['one'], updated: 1_800_000_000_000, activity: 'The layout is ready for review.', next: 'Verify the mobile layout.', humanCopy: true, copyState: 'current', contributors: [agent] };

describe('List and Agents subpage reading flow', () => {
  it('distinguishes recorded next steps and explicit human review while preserving the return view and filters', () => {
    const html = requestList([row], state);
    expect(html).toContain('What’s next');
    expect(html).toContain('Verify the mobile layout.');
    expect(html).toContain('next-step-human');
    expect(html).toContain('Review the result and recorded evidence.');
    expect(html).toContain('from=list');
    expect(html).toContain('range=week');
    expect(html).toContain('sort=title');
    expect(html).toContain('q=layout');
    const recorded = requestList([{ ...row, status: 'unknown', next: row.activity }], state);
    expect(recorded).toContain('Latest update');
    expect(recorded).not.toContain('next-step-human');
  });

  it('pairs the newest request title with its own update even when requests arrive out of order', () => {
    const html = agentCards([{ ...row, id: 'older', title: 'Older request', activity: 'Older activity', updated: row.updated - 100 }, row], state);
    expect(html).toContain('class="agent-summary">Review layout');
    expect(html).toContain('class="agent-update">The layout is ready for review.');
    expect(html).toContain('Also contributing to');
    expect(html).toContain('<p>Older request</p>');
    expect(html).not.toContain('Older activity');
    expect(html).toContain('agent=reviewer%2F1');
  });

  it('gives unassigned work a List route without dropping the active filters', () => {
    const html = agentCards([{ ...row, contributors: [] }], { ...state, agentId: 'stale-agent' });
    expect(html).toContain('No contributors in this view');
    expect(html).toContain('Browse requests');
    expect(html).toContain('#list?');
    expect(html).toContain('range=week');
    expect(html).toContain('q=layout');
    expect(html).not.toContain('stale-agent');
  });
});
