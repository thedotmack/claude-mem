import { describe, expect, it } from 'bun:test';
import { presentWork, scopeWork, sortWork } from '../../src/ui/work-view/presentation.js';
import { afterShip, agentCards, parsePersonalRoute, personalRoute, requestCards, requestFacts, requestList, requestPage, workstreamPage } from '../../src/ui/work-view/request-views.js';

const now = 1_800_000_000_000;
const source = {
  humanRequests: [{ id: 'request', title: 'Make the local cards easier to follow', original: { text: 'Make the local cards easier to follow', url: '/api/work-view/evidence/prompt/1' },
    projects: ['one', 'two'], agentIds: ['alice', 'sam'], updatedAtEpoch: now,
    items: [{ id: 'item', title: 'Compare card layouts', kind: 'work-state', status: 'doing', progress: { text: 'Compared the request cards.' }, nextStep: { text: 'Read the contributor line.' }, lastUpdateEpoch: now }],
    workstreams: [{ id: 'layout', title: 'Card layout', agentIds: ['sam'], items: [{ id: 'layout-item', title: 'Preserve the card hierarchy', status: 'doing', kind: 'work-state', lastUpdateEpoch: now, url: '/api/work-view/evidence/work-state/2' }], activity: [] }] }],
  agents: [{ id: 'alice', label: 'Alice', platformSource: 'claude' }, { id: 'sam', label: 'Sam', platformSource: 'codex', agentType: 'reviewer' }, { id: 'other', label: 'Unrelated agent', platformSource: 'codex' }],
};
const state = { view: 'cards', sort: 'attention', filter: 'all', range: 'day', project: '', query: '', changed: new Set(), unread: new Set() };

describe('restored request cards and navigation', () => {
  it('preserves every recorded contributor and searches secondary contributors without including unrelated agents', () => {
    const rows = presentWork(source, [], now).rows;
    expect(rows[0].contributors.map(agent => agent.label)).toEqual(['Alice', 'Sam']);
    expect(scopeWork(rows, { query: 'Sam', now })).toHaveLength(1);
    expect(scopeWork(rows, { query: 'reviewer', now })).toHaveLength(1);
    expect(scopeWork(rows, { query: 'Unrelated', now })).toHaveLength(0);
    const html = requestCards(rows, state);
    expect(html).toContain('Alice'); expect(html).toContain('Sam');
    expect(html).not.toContain('Unrelated agent');
    expect(html).toContain('>Just now</time>');
    expect(html).toContain('datetime='); expect(html).toContain('title=');
  });
  it('groups contributors from one tool into one line, as on the approved cards', () => {
    const many = { ...source, humanRequests: [{ ...source.humanRequests[0], agentIds: ['c1', 'c2', 'c3'] }],
      agents: ['c1', 'c2', 'c3'].map(id => ({ id, label: 'Codex', platformSource: 'codex' })) };
    const html = requestCards(presentWork(many, [], now).rows, state);
    expect(html.match(/class="card-contributor"/g)).toHaveLength(1);
    expect(html).toContain('Codex<span class="contributor-count"> · 3 contributors</span>');
  });
  it('labels a worktree checkout by its repository', () => {
    const worktree = { ...source, humanRequests: [{ ...source.humanRequests[0], projects: ['claude-mem/fluff-shawl-741df66a'] }] };
    const html = requestCards(presentWork(worktree, [], now).rows, state);
    expect(html).toContain('>claude-mem</span>');
    expect(html).not.toContain('>claude-mem/fluff-shawl-741df66a<');
  });
  it('retains source-grounded workstream titles and scoped contributors without generated copy', () => {
    const row = presentWork(source, [], now).rows[0];
    expect(row.workstreams[0].title).toBe('Card layout');
    expect(row.workstreams[0].summary).toBe('Preserve the card hierarchy');
    expect(row.workstreams[0].contributors.map(agent => agent.label)).toEqual(['Sam']);
    const page = requestPage(row, { ...state, requestId: row.id, from: 'list' });
    expect(page).toContain('Work behind this request');
    expect(page).toContain('work=layout');
    const records = workstreamPage(row, row.workstreams[0]);
    expect(records).toContain('Recorded changes');
    expect(records).toContain('data-evidence-kind="work-state"');
    expect(records).not.toContain('Alice');
  });
  it('round-trips request, workstream, return view, agent scope and filters in the URL', () => {
    const selected = { ...state, view: 'request', requestId: 'request/with spaces', workId: 'stream&2', from: 'list', agentId: 'sam', sort: 'oldest', project: 'one/two', range: 'week', filter: 'ready', query: 'a & b' };
    const parsed = parsePersonalRoute(personalRoute('request', selected));
    for (const key of ['view', 'requestId', 'workId', 'from', 'agentId', 'sort', 'project', 'range', 'filter', 'query']) expect(parsed[key]).toBe(selected[key]);
    expect(parsePersonalRoute('#board').view).toBe('list');
    expect(parsePersonalRoute('#cards').range).toBe('day');
  });
  it('shows a new-update cue only for unread records and safely escapes source content', () => {
    const rows = presentWork(source, [], now).rows;
    const html = requestCards([{ ...rows[0], title: '<img onerror=alert(1)>', contributors: [{ id: 'unsafe', label: '<script>x</script>', icon: null }] }], { ...state, unread: new Set(['request']) });
    expect(html).toContain('New update');
    expect(html).not.toContain('<img onerror'); expect(html).not.toContain('<script>');
    expect(requestCards(rows, state)).not.toContain('New update');
    expect(requestList(rows, state)).toContain('aria-label="Requests"');
    expect(agentCards(rows, state)).toContain('Alice'); expect(agentCards(rows, state)).toContain('Sam');
  });
  it('sorts overlaid human review state without changing recorded source state or input order', () => {
    const rows = [
      { id: 'checked', title: 'Checked', status: 'ready', review: { checked: true }, updated: now + 5 },
      { id: 'working', title: 'Working', status: 'working', updated: now + 4 },
      { id: 'ready', title: 'Ready', status: 'ready', updated: now + 3 },
      { id: 'needs', title: 'Needs you', status: 'needs', updated: now + 2 },
    ];
    expect(sortWork(rows).map(row => row.id)).toEqual(['needs', 'ready', 'working', 'checked']);
    expect(rows.map(row => row.id)).toEqual(['checked', 'working', 'ready', 'needs']);
    expect(rows[0].status).toBe('ready');
    expect(sortWork(rows, 'latest').map(row => row.id)).toEqual(['checked', 'working', 'ready', 'needs']);
  });
  it('keeps missing timestamps last and uses deterministic title and ID ties', () => {
    const rows = [{ id: 'z', title: 'Same', status: 'working', updated: 0 }, { id: 'b', title: 'Same', status: 'working', updated: now }, { id: 'a', title: 'Same', status: 'working', updated: now }];
    expect(sortWork(rows, 'oldest').map(row => row.id)).toEqual(['a', 'b', 'z']);
    expect(sortWork(rows, 'title').map(row => row.id)).toEqual(['a', 'b', 'z']);
  });
  it('keeps recorded request facts and safely source-linked after-ship resources', () => {
    const row = presentWork({ ...source, humanRequests: [{ ...source.humanRequests[0], startedAtEpoch: now - 60_000, stageSourceText: 'Reviewing the cards', shipEstimate: 'After the accessibility check', requestedBy: 'Alex', afterShip: {
      resources: [{ kind: 'documentation', url: 'https://example.com/guide', sourceRefs: [{ kind: 'work-state', id: 3 }] }, { kind: 'promotion', url: 'javascript:alert(1)' }, { kind: 'promotion', url: 'https://user:secret@example.com/' }],
      classifications: [{ text: 'Interface improvement', sourceRefs: [{ kind: 'observation', id: 4 }] }], notes: [],
    } }] }, [], now).rows[0];
    const facts = requestFacts(row);
    expect(facts).toContain('Alice'); expect(facts).toContain('Sam'); expect(facts).toContain('Alex');
    expect(facts).toContain('Reviewing the cards'); expect(facts).toContain('After the accessibility check');
    expect(facts).toContain('data-request-elapsed="request"');
    const linked = afterShip(row);
    expect(linked).toContain('https://example.com/guide');
    expect(linked).toContain('data-evidence-kind="work-state"');
    expect(linked).toContain('data-evidence-kind="observation"');
    expect(linked).not.toContain('javascript:'); expect(linked).not.toContain('secret');
  });
});
