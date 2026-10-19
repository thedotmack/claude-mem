import { describe, expect, it } from 'bun:test';
import { readTeamResource, sharingDescription, setupTeamView, filterTeamLists, teamCardHtml, teamReceiptIsStale, teamTaskActivity } from '../../src/ui/work-view/team-view.js';

describe('shared workspace transport', () => {
  it('distinguishes an empty sharing scope from sharing every project', () => {
    expect(sharingDescription({ broadcasting: true, projects: [] })).toContain('no projects selected');
    expect(sharingDescription({ broadcasting: true, projects: null })).toContain('all projects');
    expect(sharingDescription({ broadcasting: true, projects: ['one'] })).toContain('one');
    expect(sharingDescription({ broadcasting: false, projects: null })).toContain('Sharing from this computer is off');
  });
  it('retains authorization failure status without exposing an HTML error body', async () => {
    try {
      await readTeamResource('/board', undefined, { fetcher: async () => new Response('<html>private diagnostic</html>', { status: 403 }) });
      throw new Error('Expected refusal');
    } catch (error) {
      expect((error as Error & { status: number }).status).toBe(403);
      expect((error as Error).message).toBe('Shared work could not be loaded.');
    }
  });

  it('times out a response whose headers arrive but body stalls', async () => {
    const fetcher = async (_path: string, options: { signal: AbortSignal }) => new Response(new ReadableStream({
      start(controller) { options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true }); },
    }));
    await expect(readTeamResource('/board', undefined, { timeoutMs: 10, fetcher })).rejects.toThrow('team connection timed out');
  });

  it('preserves cancellation when switching away from the shared workspace', async () => {
    const controller = new AbortController();
    const fetcher = async (_path: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    const pending = readTeamResource('/board', controller.signal, { fetcher });
    controller.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });

  it('rejects an unreadable successful reply rather than claiming disconnection', async () => {
    await expect(readTeamResource('/status', undefined, { fetcher: async () => new Response('not JSON') })).rejects.toThrow('could not be read');
  });

  it('drops a queued board when a newer board is applied after reading ends', async () => {
    const globals = ['document', 'window', 'location', 'history', 'fetch', 'setInterval', 'clearInterval'];
    const saved = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const elements = new Map<string, any>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', dataset: {}, setAttribute() {}, focus() {}, replaceChildren() { this.innerHTML = ''; } });
      return elements.get(id);
    };
    let reading = false;
    let poll: () => Promise<void>;
    let requested = 0;
    const board = (name: string) => ({ lists: [{ user_id: 'member', project: 'example', name, display_name: 'Teammate', state: [], tasks: [], last_written_at: new Date().toISOString() }], findings: [] });
    const replies = [board('Applied A'), board('Queued B'), board('Latest C')];
    try {
      Object.assign(globalThis, {
        document: { addEventListener() {}, getElementById: element, visibilityState: 'visible', activeElement: null, querySelector: () => reading ? {} : null, querySelectorAll: () => [] },
        window: { scrollY: 0, addEventListener() {} },
        location: { hash: '#teambrain', pathname: '/', search: '' },
        history: { replaceState() {} },
        fetch: async (path: string) => Response.json(path.includes('/status')
          ? { configured: true, teams: [{ id: 'team', name: 'Team', broadcasting: false }] }
          : replies[requested++]),
        setInterval: (callback: () => Promise<void>) => { poll = callback; return 1; },
        clearInterval() {},
      });
      const settled = async (condition: () => boolean) => {
        for (let attempts = 0; attempts < 20 && !condition(); attempts++) await new Promise(resolve => setImmediate(resolve));
        expect(condition()).toBe(true);
      };
      setupTeamView();
      await settled(() => element('team-cards').innerHTML.includes('Applied A'));
      reading = true;
      poll!();
      await settled(() => element('team-updates').innerHTML.includes('Show updates'));
      expect(element('team-cards').innerHTML).toContain('Applied A');
      reading = false;
      poll!();
      await settled(() => element('team-cards').innerHTML.includes('Latest C'));
      expect(element('team-updates').innerHTML).toBe('');
      expect(element('team-cards').innerHTML).not.toContain('Queued B');
    } finally {
      for (const name of globals) {
        const descriptor = saved.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    }
  });
});


describe('shared work presentation', () => {
  const list = (overrides = {}) => ({ user_id: 'member-a', display_name: 'Avery', project: 'local-project', name: 'Release checklist', closed: false,
    state: [['human_summary', 'Validate the release'], ['status', 'doing']], last_written_at: '2026-10-17T10:00:00Z', state_updated_at: null, closed_task_count: 0,
    tasks: [{ name: 'Review result', status: 'needs-input', updated_at: '2026-10-17T09:59:00Z', details: [['next_step', 'Check the screenshot']], finding_ids: [7] }], ...overrides });

  it('shows recorded status, contributor, project, handoff and linked finding details without dispatch actions', () => {
    const finding = { id: 7, type: 'collision', title: 'Overlapping edits', subtitle: 'Coordinate first', narrative: 'Two changes touch the same file.', member_ids: ['member-a'], created_at: '2026-10-17T09:58:00Z' };
    const html = teamCardHtml(list(), new Map([[7, finding]]), new Map([['member-a', 'Avery']]), true);
    for (const text of ['Tasks: Needs you', 'Recorded list status: In progress', 'Avery', 'local-project', 'Next step', 'Check the screenshot', 'Needs you', 'Overlapping work', 'Two changes touch the same file.', 'data-team-time', '1 open task']) expect(html).toContain(text);
    expect(html).toContain(' open>');
    expect(html).not.toContain('Mark checked');
    expect(html).not.toContain('Assign');
  });

  it('summarizes task attention without inventing a parent lifecycle or review state', () => {
    const tasks = (...statuses: Array<string | null>) => statuses.map(status => ({ status }));
    expect(teamTaskActivity(list({ state: [], tasks: tasks('todo', 'doing', 'blocked', 'needs-input') }))).toEqual({ state: 'needs', label: 'Tasks: Needs you', count: '4 open tasks' });
    expect(teamTaskActivity(list({ tasks: tasks('doing', 'blocked') })).state).toBe('blocked');
    expect(teamTaskActivity(list({ tasks: tasks('todo', 'doing') })).state).toBe('working');
    expect(teamTaskActivity(list({ tasks: tasks('queued') })).state).toBe('todo');
    expect(teamTaskActivity(list({ closed: true, tasks: tasks('done') }))).toEqual({ state: 'closed', label: 'List closed', count: '0 open tasks' });
    expect(teamTaskActivity(list({ tasks: tasks('done', 'completed') }))).toEqual({ state: 'quiet', label: 'No open tasks', count: '0 open tasks' });
    expect(teamTaskActivity(list({ tasks: tasks(null) })).label).toBe('Task status not recorded');
    const html = teamCardHtml(list({ state: [], tasks: [] }));
    expect(html).not.toContain('Ready to check'); expect(html).not.toContain('Checked');
  });

  it('escapes shared content and keeps missing status or activity honest', () => {
    const html = teamCardHtml(list({ name: '<script>bad</script>', display_name: '<b>Person</b>', state: [], last_written_at: '', tasks: [] }));
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;Person&lt;/b&gt;');
    expect(html).toContain('Time not recorded');
    expect(html).toContain('0 open tasks');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('In progress');
  });

  it('searches named contributors, recorded task details and linked findings within project scope', () => {
    const first = list(), second = list({ user_id: 'member-b', display_name: 'Morgan', project: 'other-project', name: 'Second list' });
    const board = { lists: [first, second], findings: [{ id: 7, title: 'Coordinate parser changes', narrative: 'Avoid duplicate work.' }] };
    expect(filterTeamLists(board, { search: 'AVERY' })).toEqual([first]);
    expect(filterTeamLists(board, { search: 'screenshot', project: 'local-project' })).toEqual([first]);
    expect(filterTeamLists(board, { search: 'parser', project: 'other-project' })).toEqual([second]);
    expect(filterTeamLists(board, { search: 'Morgan', project: 'local-project' })).toEqual([]);
  });

  it('measures stale shared receipts on a monotonic clock', () => {
    expect(teamReceiptIsStale(null, 50000)).toBe(false);
    expect(teamReceiptIsStale(0, 35000)).toBe(false);
    expect(teamReceiptIsStale(0, 35001)).toBe(true);
    expect(teamReceiptIsStale(50000, 10)).toBe(true);
  });

  it('preserves the last successful update and issue across retry and recovery on the five-second poll', async () => {
    const names = ['document', 'window', 'location', 'history', 'fetch', 'setInterval', 'clearInterval', 'performance'];
    const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const elements = new Map<string, any>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', dataset: {}, hidden: false, setAttribute() {}, focus() {}, replaceChildren() { this.innerHTML = ''; } });
      return elements.get(id);
    };
    let poll: () => void = () => {}, visible: () => void = () => {}, fail = false, period = 0, monotonic = 0;
    try {
      Object.assign(globalThis, {
        document: { addEventListener(event: string, callback: () => void) { if (event === 'visibilitychange') visible = callback; }, getElementById: element, visibilityState: 'visible', activeElement: null, querySelector: () => null, querySelectorAll: () => [] },
        performance: { now: () => monotonic },
        window: { scrollY: 0, addEventListener() {} }, location: { hash: '#teambrain', pathname: '/', search: '' }, history: { replaceState() {} },
        fetch: async (path: string) => path.includes('/status') ? Response.json({ configured: true, teams: [{ id: 'team', name: 'Team', broadcasting: false }] })
          : fail ? Response.json({ error: 'Temporarily unavailable' }, { status: 503 }) : Response.json({ lists: [list()], findings: [] }),
        setInterval: (callback: () => void, ms: number) => { poll = callback; period = ms; return 1; }, clearInterval() {},
      });
      const settled = async (condition: () => boolean) => { for (let i = 0; i < 30 && !condition(); i++) await new Promise(resolve => setImmediate(resolve)); expect(condition()).toBe(true); };
      setupTeamView();
      await settled(() => element('team-health').dataset.state === 'live');
      expect(period).toBe(5000);
      const boardBefore = element('team-cards').innerHTML, receivedBefore = element('team-received').textContent;
      monotonic = 40000; visible();
      expect(element('team-health').dataset.state).toBe('stale');
      expect(element('team-cards').innerHTML).toBe(boardBefore);
      await settled(() => element('team-health').dataset.state === 'live');
      fail = true; poll();
      await settled(() => element('team-health').dataset.state === 'error');
      expect(element('team-cards').innerHTML).toBe(boardBefore);
      expect(element('team-received').textContent).toBe(receivedBefore);
      expect(element('team-last-error').textContent).toContain('Temporarily unavailable');
      fail = false; poll();
      await settled(() => element('team-health').dataset.state === 'live');
      expect(element('team-last-error').hidden).toBe(false);
      expect(element('team-last-error').textContent).toContain('Temporarily unavailable');
    } finally {
      for (const name of names) { const descriptor = saved.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name]; }
    }
  });
});
