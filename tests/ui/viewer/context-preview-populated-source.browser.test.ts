import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, failOnCiWithoutChrome,
  htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for context-preview regressions');
for (const source of ['codex', 'opencode']) {
  (chromeExecutablePath ? it : it.skip)(`selects the populated ${source} catalog instead of an empty default source`, async () => {
    const bundle = compileBrowserFixture(`
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { useContextPreview } from './src/ui/viewer/hooks/useContextPreview';
        import { DEFAULT_SETTINGS } from './src/ui/viewer/constants/settings';
        let current;
        function Probe() { current = useContextPreview(DEFAULT_SETTINGS); return null; }
        createRoot(document.getElementById('root')).render(<Probe />);
        (async () => {
          try {
            const deadline = Date.now() + 5000;
            while (current?.selectedSource !== '${source}' || current?.selectedProject !== 'project' || current?.preview !== 'PREVIEW:${source}:project') {
              if (Date.now() > deadline) throw new Error('Expected completed preview did not load');
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            await fetch('/result', { method: 'POST', body: JSON.stringify({
              source: current.selectedSource, project: current.selectedProject, preview: current.preview,
            }) });
          } catch (error) { await fetch('/result', { method: 'POST', body: JSON.stringify({ failure: String(error) }) }); }
        })();
      `);
    let report!: (value: unknown) => void;
    const result = new Promise<unknown>(resolve => { report = resolve; });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/') return htmlResponse(FIXTURE_PAGE_HTML);
      if (url.pathname === '/fixture.js') return scriptResponse(bundle);
      if (url.pathname === '/api/projects') return Response.json({ projects: ['project'], sources: [source], projectsBySource: { [source]: ['project'] } });
      if (url.pathname === '/api/context/preview') {
        await Bun.sleep(650);
        return new Response(`PREVIEW:${url.searchParams.get('platformSource')}:${url.searchParams.get('project')}`);
      }
      if (url.pathname === '/result') { report(await request.json()); return new Response('received'); }
      return new Response('Not found', { status: 404 });
    } });
    let chrome: OwnedChrome | undefined;
    try {
      chrome = launchChrome(server.url.href, { profilePrefix: 'cm-populated-preview-', extraFlags: UNTHROTTLED_TIMER_FLAGS });
      const value = await withTimeout(result, 30000, 'Browser timed out');
      expect(value).toEqual({ source, project: 'project', preview: `PREVIEW:${source}:project` });
    } finally {
      await chrome?.close(); server.stop(true);
    }
  }, 45000);
}
