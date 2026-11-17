import { expect, it } from 'bun:test';
import {
  UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, failOnCiWithoutChrome, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { launchSettingsFixture, serveSettingsFixture } from './settings-fixture';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the settings load-gate regressions.');

// Until GET /api/settings succeeds the form holds DEFAULT_SETTINGS. A save
// then would post those defaults over settings.json: provider, worker port,
// and blank API keys. Save has to wait for the load, and a failed load offers
// Retry instead of a save.
for (const scenario of ['held', 'failed'] as const) {
  (chromeExecutablePath ? it : it.skip)(`keeps Save from posting defaults while the settings load is ${scenario}`, async () => {
    const script = `
        async function until(predicate, what) {
          const deadline = Date.now() + 6000;
          while (!predicate()) {
            if (Date.now() > deadline) throw new Error(what + ' did not happen');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        async function settle() { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); }
        const save = () => document.querySelector('.save-btn');
        const observations = () => [...document.querySelectorAll('.form-field')]
          .find(field => field.textContent.startsWith('Observations'))?.querySelector('input');
        const status = () => document.querySelector('.save-status').textContent;
        // A failed load: the plain words first, the raw cause folded under Details (G17).
        const failure = () => {
          const line = document.querySelector('.save-status .error');
          const details = line?.querySelector('details');
          return line ? { plain: line.firstChild?.textContent ?? null, cause: details?.querySelector('pre')?.textContent ?? null,
            folded: details ? !details.open : null } : null;
        };
        const snapshot = () => ({ saveDisabled: save().disabled, saveDimmed: save().getAttribute('aria-disabled'),
          inputDisabled: observations().matches(':disabled'), observations: observations().value, status: status(), failure: failure() });
        let blocked;
        (async () => {
          try {
            await fetch('/ready');
            await until(() => save() && observations(), 'Settings render');
            // The server now holds the first GET, or has answered it with a 500.
            await fetch('/first-load-seen');
            // Wait for the load status, but take the snapshot and click Save
            // even without it, so a build that lets Save through shows its POST.
            await until(() => status().includes(${scenario === 'held' ? "'Loading settings'" : "'Could not load settings'"}), 'Load status').catch(() => {});
            const retry = [...document.querySelectorAll('.save-status button')].find(button => button.textContent === 'Retry');
            blocked = { ...snapshot(), retry: !!retry };
            save().click(); await settle();
            if (${scenario === 'held'}) await fetch('/release-load');
            else if (retry) retry.click();
            else throw new Error('No Retry after the failed load');
            await until(() => !save().disabled && observations().value === '7', 'Settings load');
            await settle();
            const loaded = snapshot();
            // Nothing changed yet: Save is dimmed ("No changes to save.") and a click on it posts nothing.
            save().click(); await settle();
            const field = observations();
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '8');
            field.dispatchEvent(new Event('input', { bubbles: true }));
            await settle();
            save().click();
            await until(() => status().includes('Saved'), 'Save');
            await fetch('/result', { method: 'POST', body: JSON.stringify({ blocked, loaded }) });
          } catch (error) { await fetch('/result', { method: 'POST', body: JSON.stringify({ blocked, failure: String(error) }) }); }
        })();
      `;
    const stored = { CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_MEM_CONTEXT_OBSERVATIONS: '7', CLAUDE_MEM_WORKER_PORT: '41234' };
    const posts: any[] = [];
    let postsWhenLoaded: number | null = null;
    let loads = 0;
    let releaseLoad!: () => void;
    const loadReleased = new Promise<void>(resolve => { releaseLoad = resolve; });
    let markFirstLoad!: () => void;
    const firstLoadSeen = new Promise<void>(resolve => { markFirstLoad = resolve; });
    let report!: (value: unknown) => void;
    const result = new Promise<any>(resolve => { report = resolve; });
    const { server, ready } = serveSettingsFixture({
      script,
      post: async request => { posts.push(await request.json()); return Response.json({ success: true }); },
      settings: async () => {
        loads++;
        markFirstLoad();
        if (scenario === 'failed' && loads === 1) return new Response('settings outage', { status: 500 });
        if (scenario === 'held') await loadReleased;
        postsWhenLoaded = posts.length;
        return Response.json(stored);
      },
      route: async request => {
        const path = new URL(request.url).pathname;
        if (path === '/first-load-seen') { await firstLoadSeen; return new Response('seen'); }
        if (path === '/release-load') { releaseLoad(); return new Response('released'); }
        if (path === '/result') { report(await request.json()); return new Response('received'); }
      },
    });
    let chrome: OwnedChrome | undefined;
    try {
      chrome = await launchSettingsFixture(server.url.href, ready, 'claude-mem-settings-load-gate-', UNTHROTTLED_TIMER_FLAGS);
      const reported = await withTimeout(result, 25000, 'Settings fixture timed out');
      // Before the load: the form and Save are disabled, and a Save click
      // posts nothing (it would have posted the defaults).
      expect({ ...reported.blocked, postsBeforeLoad: posts.slice(0, postsWhenLoaded ?? posts.length) }).toEqual({
        saveDisabled: true, saveDimmed: 'true', inputDisabled: true, observations: '50',
        status: scenario === 'held' ? 'Loading settings…' : 'Could not load settings.DetailsHTTP 500Retry',
        failure: scenario === 'held' ? null : { plain: 'Could not load settings.', cause: 'HTTP 500', folded: true },
        retry: scenario === 'failed', postsBeforeLoad: [],
      });
      expect(reported.failure).toBeUndefined();
      expect(reported.loaded).toEqual({ saveDisabled: false, saveDimmed: 'true', inputDisabled: false, observations: '7', status: '', failure: null });
      expect(loads).toBe(scenario === 'failed' ? 2 : 1);
      // The one POST comes after the load and after an edit: the dimmed Save
      // before it posted nothing, and it carries only the edited key, neither
      // the defaults nor an echo of the loaded values that could put back a
      // change made elsewhere since (#4597).
      expect(postsWhenLoaded).toBe(0);
      expect(posts).toEqual([{ CLAUDE_MEM_CONTEXT_OBSERVATIONS: '8' }]);
    } finally {
      releaseLoad(); await chrome?.close(); server.stop(true);
    }
  }, 80000);
}
