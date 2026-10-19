import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parsePersonalRoute, personalRoute } from '../../src/ui/work-view/request-views.js';

describe('top-level work navigation', () => {
  it('keeps the local update notice outside the independently hidden workspaces', () => {
    const html = readFileSync(new URL('../../src/ui/work-view/index.html', import.meta.url), 'utf8');
    const beforeWorkspaces = html.slice(html.indexOf('<main '), html.indexOf('<div id="personal-workspace"'));
    expect(beforeWorkspaces).toContain('<div id="updates-banner"></div>');
    expect(html.match(/id="updates-banner"/g)).toHaveLength(1);
  });
  it('recognizes Goals and TeamBrain without carrying request filters into their URLs', () => {
    for (const view of ['goals', 'teambrain']) {
      expect(parsePersonalRoute(`#${view}`).view).toBe(view);
      expect(personalRoute(view, { requestId: 'one', project: 'project', query: 'query', range: 'all' })).toBe(`#${view}`);
    }
    expect(parsePersonalRoute('#board').view).toBe('list');
    expect(parsePersonalRoute('#unknown').view).toBe('cards');
  });

  it('opens Goals directly, preserves My Work scope, and follows history across all three pages', async () => {
    const names = ['document', 'window', 'location', 'history', 'fetch', 'EventSource', 'setInterval', 'clearInterval', 'CSS', 'requestAnimationFrame'];
    const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const elements = new Map<string, any>(), documentEvents = new Map<string, Function>(), windowEvents = new Map<string, Function[]>(), sourceEvents = new Map<string, Function>();
    let focused = '';
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, {
        id, innerHTML: '', textContent: '', value: '', dataset: {}, attributes: {}, hidden: false, parentElement: {},
        setAttribute(name: string, value: string) { this.attributes[name] = value; },
        addEventListener(name: string, callback: Function) { this[name] = callback; },
        querySelectorAll: () => [], querySelector: () => null, contains: () => false, closest: () => null,
        replaceChildren() { this.innerHTML = ''; }, focus() { focused = id; },
      });
      return elements.get(id);
    };
    const views = ['cards', 'list', 'agents'].map(view => ({ dataset: { view }, attributes: {} as Record<string, string>, setAttribute(name: string, value: string) { this.attributes[name] = value; } }));
    const routes = ['#goals']; let routeIndex = 0;
    const location = { hash: '#goals', pathname: '/', search: '' };
    const changeLocation = (route: string) => { location.hash = route.slice(route.indexOf('#')); };
    const fire = (name: string) => { for (const callback of windowEvents.get(name) || []) callback({}); };
    const move = (offset: number) => { routeIndex += offset; changeLocation(routes[routeIndex]); fire('popstate'); fire('hashchange'); };
    const pressView = async (view: string) => {
      const button = { dataset: { view }, closest: (selector: string) => selector === 'button' ? button : null };
      await documentEvents.get('click')!({ target: button, button: 0 });
    };
    const initialSnapshot = { revision: 'one',
      humanRequests: [{ id: 'request-one', title: 'Release notes', original: { text: 'Write the release notes' }, updatedAtEpoch: Date.now(),
        items: [{ id: 'item-one', title: 'Write release notes', kind: 'work-state', status: 'doing', progress: { text: 'Drafting release notes' }, lastUpdateEpoch: Date.now() }], workstreams: [] }],
      agents: [], unlinkedWork: [], goals: null, source: { connected: true } };
    try {
      Object.assign(globalThis, {
        document: { title: '', activeElement: null, visibilityState: 'visible', getElementById: element,
          addEventListener(name: string, callback: Function) { documentEvents.set(name, callback); },
          querySelector: () => null, querySelectorAll: (selector: string) => selector === '[data-view]' ? views : [],
        },
        window: { scrollY: 0, scrollTo(_x: number, y: number) { this.scrollY = y; }, addEventListener(name: string, callback: Function) { windowEvents.set(name, [...windowEvents.get(name) || [], callback]); } },
        location,
        history: {
          replaceState(_state: unknown, _title: string, route: string) { routes[routeIndex] = route; changeLocation(route); },
          pushState(_state: unknown, _title: string, route: string) { routes.splice(++routeIndex); routes.push(route); changeLocation(route); },
        },
        fetch: async (path: string) => Response.json(path === '/api/work-view' ? initialSnapshot : { configured: false, teams: [] }),
        EventSource: class { addEventListener(name: string, callback: Function) { sourceEvents.set(name, callback); } close() {} },
        setInterval: () => 1, clearInterval() {},
        CSS: { escape: (value: string) => value }, requestAnimationFrame: (callback: Function) => callback(),
      });
      await import('../../src/ui/work-view/app.js?navigation-test');
      await new Promise(resolve => setImmediate(resolve));
      expect(location.hash).toBe('#goals');
      expect(element('goals-workspace').hidden).toBe(false);
      expect(element('personal-workspace').hidden).toBe(true);
      expect(element('workspace-goals').attributes['aria-pressed']).toBe('true');
      expect(element('goals').innerHTML).toContain('No goals recorded yet');
      expect(element('goals').innerHTML.match(/<h1 /g)).toHaveLength(1);

      element('workspace-personal').onclick();
      expect(element('status-tabs').innerHTML).toContain('data-filter="all"');
      expect(element('status-tabs').innerHTML).toContain('data-filter="working"');
      expect(element('status-tabs').innerHTML).not.toContain('data-filter="needs"');
      let skipPrevented = false;
      element('skip-to-content').click({ detail: 0, preventDefault() { skipPrevented = true; } });
      expect(skipPrevented).toBe(true);
      expect(focused).toBe('main');
      expect(location.hash).toBe('#cards');

      const goals = { listName: 'owner-goals', priorities: [], openAsks: [{ id: 'ask-one', rank: 1, title: 'First ask', evidence: [] }] };
      sourceEvents.get('work-view')!({ data: JSON.stringify({ ...initialSnapshot, revision: 'two', goals }) });
      element('workspace-goals').onclick();
      element('skip-to-content').click({ detail: 0, preventDefault() {} });
      expect(location.hash).toBe('#goals');
      expect(element('workspace-goals').attributes['aria-pressed']).toBe('true');
      expect(focused).toBe('main');
      expect(element('goals').innerHTML).toContain('First ask');

      const readerFocus = element('goals-asks-heading');
      const openAsks = { dataset: { goal: 'all-open-asks' }, open: true };
      element('goals').contains = (active: any) => active === readerFocus;
      element('goals').querySelector = (selector: string) => selector === '#goals-asks-heading' ? readerFocus : null;
      element('goals').querySelectorAll = () => [openAsks];
      (globalThis as any).document.querySelectorAll = (selector: string) => selector === 'details[open][data-goal]' ? [openAsks] : selector === '[data-view]' ? views : [];
      (globalThis as any).document.activeElement = readerFocus;
      (globalThis as any).window.scrollY = 480;
      sourceEvents.get('work-view')!({ data: JSON.stringify({ ...initialSnapshot, revision: 'three', goals: { ...goals, openAsks: [{ ...goals.openAsks[0], title: 'Updated ask' }] } }) });
      expect(element('updates-banner').hidden).toBe(false);
      expect(element('updates-banner').innerHTML).toContain('Show updates');
      expect(element('goals').innerHTML).toContain('First ask');
      expect(element('goals').innerHTML).not.toContain('Updated ask');
      expect((globalThis as any).window.scrollY).toBe(480);
      (globalThis as any).document.activeElement = element('apply-updates');
      element('apply-updates').onclick();
      expect(element('goals').innerHTML).toContain('Updated ask');
      expect(element('updates-banner').innerHTML).toBe('');
      expect((globalThis as any).window.scrollY).toBe(480);
      expect(focused).toBe('goals-asks-heading');
      expect(openAsks.open).toBe(true);
      expect(element('status-tabs').innerHTML).not.toContain('data-filter="ready"');
      expect(element('status-tabs').innerHTML).not.toContain('data-filter="checked"');
      await pressView('list');
      element('search').input({ target: { value: 'release notes' } });
      const scopedWork = location.hash;
      expect(scopedWork).toBe('#list?q=release+notes');
      element('workspace-goals').onclick();
      expect(focused).toBe('goals-heading');
      element('workspace-team').onclick();
      expect(location.hash).toBe('#teambrain');
      expect(element('team-workspace').hidden).toBe(false);
      expect(element('goals-workspace').hidden).toBe(true);
      expect(element('workspace-team').attributes['aria-pressed']).toBe('true');
      expect(focused).toBe('team-heading');
      move(-1);
      expect(location.hash).toBe('#goals');
      expect(element('team-workspace').hidden).toBe(true);
      expect(element('workspace-goals').attributes['aria-pressed']).toBe('true');
      move(-1);
      expect(location.hash).toBe(scopedWork);
      expect(element('personal-workspace').hidden).toBe(false);
      expect(element('search').value).toBe('release notes');
      expect(views.find(view => view.dataset.view === 'list')!.attributes['aria-pressed']).toBe('true');
      move(1);
      element('workspace-personal').onclick();
      expect(location.hash).toBe(scopedWork);

      location.hash = '#agents'; fire('hashchange');
      expect(views.find(view => view.dataset.view === 'agents')!.attributes['aria-pressed']).toBe('true');
      expect(element('goals-workspace').hidden).toBe(true);
      const requestRoute = personalRoute('request', { requestId: 'request/one', workId: 'stream&two', from: 'list', range: 'week', filter: 'ready' });
      const anchor = { getAttribute: () => requestRoute, closest: () => anchor };
      await documentEvents.get('click')!({ target: anchor, button: 0, preventDefault() {} });
      expect(location.hash).toBe(requestRoute);
      expect(element('personal-heading').hidden).toBe(true);
      expect(element('scope-trail').innerHTML).toContain('Back to My Work');
      element('workspace-goals').onclick(); element('workspace-personal').onclick();
      expect(location.hash).toBe(requestRoute);
      await new Promise(resolve => setImmediate(resolve));
      location.hash = '#cards?status=ready'; fire('hashchange');
      expect(element('status-tabs').innerHTML).toContain('data-filter="ready" aria-pressed="true"');
      expect(element('status-tabs').innerHTML).toContain('data-filter="all"');
      expect(element('status-tabs').innerHTML).toContain('data-filter="working"');
      expect(element('status-tabs').innerHTML).not.toContain('data-filter="needs"');
      element('skip-to-content').click({ detail: 0, preventDefault() {} });
      expect(location.hash).toBe('#cards?status=ready');
      expect(element('workspace-personal').attributes['aria-pressed']).toBe('true');
      (globalThis as any).document.activeElement = null;
      (globalThis as any).window.scrollY = 0;
      sourceEvents.get('work-view')!({ data: JSON.stringify({ ...initialSnapshot, revision: 'four', humanRequests: [{ ...initialSnapshot.humanRequests[0], items: [{ ...initialSnapshot.humanRequests[0].items[0], status: 'unknown' }] }] }) });
      expect(element('status-tabs').innerHTML).toContain('data-filter="unknown"');
      expect(element('status-tabs').innerHTML).not.toContain('data-filter="other"');
      location.hash = '#cards?status=other'; fire('hashchange');
      expect(element('status-tabs').innerHTML).toContain('data-filter="other" aria-pressed="true"');
    } finally {
      for (const name of names) {
        const descriptor = saved.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    }
  });
});
