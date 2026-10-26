import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome,
  htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the context-preview browser regressions.');

// This regression needs real React effects, state updates, and HTTP ordering.
// It runs in headless Chrome when installed; no mocked React dispatcher.
for (const { oldStatus, emptySource, startupDelayMs = 0 } of [
  { oldStatus: 200, emptySource: false },
  { oldStatus: 500, emptySource: false },
  { oldStatus: 200, emptySource: true },
  { oldStatus: 200, emptySource: false, startupDelayMs: 10000 },
]) {
  (chromeExecutablePath ? it : it.skip)(`keeps the current preview after an older HTTP ${oldStatus} reply (emptySource=${emptySource})${startupDelayMs ? ` after ${startupDelayMs}ms browser startup` : ''}`, async () => {
    const bundle = compileBrowserFixture(`
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { useContextPreview } from './src/ui/viewer/hooks/useContextPreview';
        import { DEFAULT_SETTINGS } from './src/ui/viewer/constants/settings';
        let oldBodyRead = false;
        const nativeFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const response = await nativeFetch(...args);
          if (String(args[0]).includes('project=project-a')) {
            const readText = response.text.bind(response);
            response.text = async () => {
              const text = await readText();
              oldBodyRead = true;
              return text;
            };
          }
          return response;
        };
        let current;
        function Probe() { current = useContextPreview(DEFAULT_SETTINGS); return null; }
        createRoot(document.getElementById('root')).render(<Probe />);
        async function until(predicate) {
          const deadline = Date.now() + 6000;
          while (!predicate()) {
            if (Date.now() > deadline) throw new Error('Fixture did not reach expected state');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        (async () => {
          try {
            await fetch('/ready');
            await until(() => current?.selectedProject === 'project-a' && current.isLoading);
            await until(asyncSeen);
            if (${emptySource}) current.setSelectedSource('codex');
            else current.setSelectedProject('project-b');
            await until(() => current.selectedProject === ${emptySource ? 'null' : "'project-b'"}
              && current.preview === ${emptySource ? "'No project selected'" : "'PREVIEW_B'"} && !current.isLoading);
            await fetch('/release');
            await until(() => oldBodyRead);
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            await fetch('/result', { method: 'POST', body: JSON.stringify({
              selectedProject: current.selectedProject, preview: current.preview,
              error: current.error, isLoading: current.isLoading,
            }) });
          } catch (error) {
            await fetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) });
          }
        })();
        let seen = false;
        function asyncSeen() {
          if (!seen) fetch('/seen').then(res => res.json()).then(value => { seen = value; });
          return seen;
        }
      `);
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let seen = false;
    let report!: (value: unknown) => void;
    const result = new Promise<unknown>(resolve => { report = resolve; });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/') return htmlResponse(FIXTURE_PAGE_HTML);
      if (url.pathname === '/fixture.js') { await Bun.sleep(startupDelayMs); return scriptResponse(bundle); }
      if (url.pathname === '/api/projects') return Response.json({ projects: ['project-a', 'project-b'], sources: ['claude'], projectsBySource: { claude: ['project-a', 'project-b'] } });
      if (url.pathname === '/ready') { markReady(); return new Response('ready'); }
      if (url.pathname === '/seen') return Response.json(seen);
      if (url.pathname === '/api/context/preview') {
        if (url.searchParams.get('project') === 'project-a') { seen = true; await held; return new Response('PREVIEW_A', { status: oldStatus }); }
        return new Response('PREVIEW_B');
      }
      if (url.pathname === '/release') { release(); return new Response('released'); }
      if (url.pathname === '/result') { report(await request.json()); return new Response('received'); }
      return new Response('Not found', { status: 404 });
    } });
    let chrome: OwnedChrome | undefined;
    try {
      chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-preview-browser-', extraFlags: UNTHROTTLED_TIMER_FLAGS });
      // Chrome startup is independent of the rendered fixture's six-second race.
      await withTimeout(ready, 30000, 'Owned browser page did not become ready');
      const reported = await withTimeout(result, 9000, 'Browser timed out');
      expect(reported).toEqual({ selectedProject: emptySource ? null : 'project-b', preview: emptySource ? 'No project selected' : 'PREVIEW_B', error: null, isLoading: false });
    } finally {
      release();
      await chrome?.close();
      server.stop(true);
    }
  }, 45000);
}
