import { describe, expect, it } from 'bun:test';
import { readTeamResource, sharingDescription, setupTeamView } from '../../src/ui/work-view/team-view.js';

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
        document: { getElementById: element, visibilityState: 'visible', activeElement: null, querySelector: () => reading ? {} : null, querySelectorAll: () => [] },
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
