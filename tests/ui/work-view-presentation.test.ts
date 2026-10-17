import { requestCards } from '../../src/ui/work-view/request-views.js';
import { describe, expect, it } from 'bun:test';
import { presentWork, effectiveStatus, statusCategory, handoffText, scopeWork } from '../../src/ui/work-view/presentation.js';

const now = 1_800_000_000_000;
function request(id = 'request-one', extras: Record<string, unknown> = {}) {
  return { id, title: 'Ship a useful local viewer', original: { text: 'Ship a useful local viewer', url: '/api/work-view/evidence/prompt/1' }, projects: ['sample'], agentIds: [], updatedAtEpoch: now,
    items: [{ id: 'work', kind: 'work-state', status: 'doing', title: 'Recorded progress', progress: { text: 'Added readable local work cards.' }, nextStep: { text: 'Review the local cards.' }, lastUpdateEpoch: now }], workstreams: [], ...extras };
}
describe('local My Work presentation', () => {
  it('renders source text immediately without generated copy', () => {
    const row = presentWork({ humanRequests: [request()] }, [], now).rows[0];
    expect(row.activity).toBe('Added readable local work cards.');
    expect(row.next).toBe('Review the local cards.');
    expect(row.status).toBe('working');
    expect(JSON.stringify(row)).not.toContain('being prepared');
  });
  it('never promotes completed child work into parent completion', () => {
    const row = presentWork({ humanRequests: [request('one', { items: [{ kind: 'work-state', status: 'done', lastUpdateEpoch: now }] })] }, [], now).rows[0];
    expect(row.status).toBe('unknown');
  });
  for (const status of ['needs-you', 'needs-input', 'waiting-on-user', 'awaiting-approval', 'needs-approval', 'Needs_Input']) {
    it(`shows explicit request_status=${status} as Needs you while preserving the original request`, () => {
      const row = presentWork({ humanRequests: [request('one', {
        lifecycle: { explicit: true, status },
        items: [{ kind: 'work-state', status: 'doing', title: 'Choose a launch price', nextStep: { text: 'Choose the price and trial terms.' }, lastUpdateEpoch: now }],
      })] }, [], now).rows[0];
      expect(row.status).toBe('needs');
      expect(row.sourceLabel).toBe('Needs you');
      expect(statusCategory(row)).toBe('needs');
      expect(row.title).toBe('Ship a useful local viewer');
      expect(row.original.text).toBe('Ship a useful local viewer');
      expect(row.next).toBe('Choose the price and trial terms.');
    });
  }
  it('does not turn an unknown explicit lifecycle label into a human handoff', () => {
    const row = presentWork({ humanRequests: [request('one', { lifecycle: { explicit: true, status: 'awaiting-something-else' } })] }, [], now).rows[0];
    expect(row.status).toBe('working');
  });
  it('separates explicit reported complete from human checked', () => {
    const row = presentWork({ humanRequests: [request('one', { lifecycle: { explicit: true, status: 'done' }, review: { checked: false } })] }, [], now).rows[0];
    expect(effectiveStatus(row)).toBe('ready');
    expect(effectiveStatus({ ...row, review: { checked: true } })).toBe('checked');
    expect(effectiveStatus({ ...row, review: { checked: false } })).toBe('ready');
  });
  it('preserves applied row order when newer work arrives', () => {
    const one = request('one'); const two = request('two', { updatedAtEpoch: now + 1 });
    const previous = presentWork({ humanRequests: [one, two] }, [], now).rows;
    const next = presentWork({ humanRequests: [request('new', { updatedAtEpoch: now + 50 }), request('one', { updatedAtEpoch: now + 40 }), two] }, previous, now).rows;
    expect(next.map(row => row.id)).toEqual(['two', 'one', 'new']);
  });
  it('keeps unlinked work separate and does not invent requests', () => {
    const result = presentWork({ humanRequests: [], unlinkedWork: [{ id: 'unlinked' }] }, [], now);
    expect(result.rows).toEqual([]); expect(result.unlinked).toEqual([{ id: 'unlinked' }]);
  });
  it('ages old recorded activity without inventing presence', () => {
    const row = presentWork({ humanRequests: [request()] }, [], now + 7 * 3600000).rows[0];
    expect(row.status).toBe('quiet');
    expect(row.sourceLabel).toBe('No recent update');
  });
  it('keeps the last good summary while newer work is summarized, and keeps original evidence', () => {
    const one = request('one', { humanCopy: { state: 'current', title: 'Readable title', summary: 'Readable summary', next: 'Inspect the result' } });
    const row = presentWork({ humanRequests: [one] }, [], now).rows[0];
    expect(row.activity).toBe('Readable summary');
    expect(row.original.text).toBe('Ship a useful local viewer');
    const stale = presentWork({ humanRequests: [{ ...one, humanCopy: { ...one.humanCopy as object, state: 'outdated' } }] }, [], now).rows[0];
    expect(stale.activity).toBe('Readable summary');
    expect(stale.title).toBe('Readable title');
    expect(requestCards([stale], { view: 'cards', changed: new Set(), unread: new Set() })).toContain('Summary updating');
    const pending = presentWork({ humanRequests: [{ ...one, humanCopy: { state: 'pending' } }] }, [], now).rows[0];
    expect(pending.activity).toBe('Added readable local work cards.');
    expect(pending.title).toBe('Ship a useful local viewer');
  });
  it('retains stream activity and accepts an unknown contributor platform', () => {
    const one = request('one', { agentIds: ['agent'], workstreams: [{ id: 'stream', items: [], activity: [{ title: 'A stream update', detail: 'Recorded stream evidence.', atEpoch: now + 1 }] }] });
    const row = presentWork({ humanRequests: [one], agents: [{ id: 'agent', platform: 'new-tool', label: 'New tool' }] }, [], now).rows[0];
    expect(row.updates.some(update => update.text === 'Recorded stream evidence.')).toBe(true);
    expect(row.icon).toBeNull();
  });
  it('makes a grounded portable handoff without inventing dispatch or assignment', () => {
    const row = presentWork({ humanRequests: [request()] }, [], now).rows[0];
    const text = handoffText(row);
    expect(text).toContain('Request: Ship a useful local viewer');
    expect(text).toContain('Recorded state: In progress');
    expect(text).toContain('Next step: Review the local cards.');
    expect(text).toContain('- Added readable local work cards.');
    expect(text).toContain('does not assign or send work');
  });
  it('counts quiet, blocked, queued and unknown states in an explicit Other category', () => {
    const categories = ['quiet', 'blocked', 'todo', 'unknown', 'closed'].map(status => statusCategory({ status }));
    expect(categories).toEqual(['other', 'other', 'other', 'other', 'other']);
    expect(statusCategory({ status: 'ready' })).toBe('ready');
    expect(statusCategory({ status: 'ready', review: { checked: true } })).toBe('checked');
  });
  it('scopes by every linked project, search and time together', () => {
    const rows = presentWork({ humanRequests: [request('shared', { projects: ['one', 'two'] }), request('old', { projects: ['two'], updatedAtEpoch: now - 2 * 86400000 })] }, [], now).rows;
    expect(scopeWork(rows, { project: 'two', range: 'day', query: 'local viewer', now }).map(row => row.id)).toEqual(['shared']);
    expect(scopeWork(rows, { project: 'missing', now })).toEqual([]);
  });
});
