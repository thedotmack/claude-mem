import { expect, it } from 'bun:test';
import { TEAMBRAIN_START_URL } from '../../../src/ui/viewer/constants/promo';
import {
  chromeExecutablePath, compileBrowserFixture, connectToPage, failOnCiWithoutChrome,
  htmlResponse, launchChrome, readViewerTemplateHtml, scriptResponse, withTimeout,
  type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the TeamBrain visibility rule.');

for (const [name, teamUrl, shown] of [
  ['empty team URL', '', true],
  ['whitespace team URL', '  ', true],
  ['configured team URL', 'https://team.example.test', false],
] as const) {
  (chromeExecutablePath ? it : it.skip)(`shows the TeamBrain link only after settings load with ${name}`, async () => {
    const bundle = compileBrowserFixture(`
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from './src/ui/viewer/App';
      import { setStoredWelcomeDismissed } from './src/ui/viewer/components/WelcomeCard';
      setStoredWelcomeDismissed(true);
      createRoot(document.getElementById('root')).render(<App />);
      fetch('/ready');
    `);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let markSettingsSeen!: () => void;
    const settingsSeen = new Promise<void>(resolve => { markSettingsSeen = resolve; });
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/') return htmlResponse(readViewerTemplateHtml());
      if (path === '/viewer-bundle.js') return scriptResponse(bundle);
      if (path === '/ready') { markReady(); return new Response('ready'); }
      if (path === '/api/settings') {
        markSettingsSeen(); await held;
        return Response.json({ CLAUDE_MEM_TEAMBRAIN_URL: teamUrl });
      }
      if (path === '/stream') return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"initial_load","projects":[]}\n\n'));
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
      if (path === '/api/projects') return Response.json({ projects: [] });
      if (path === '/api/sessions') return Response.json({ sessions: [], hasMore: false });
      return Response.json({ items: [], hasMore: false });
    } });
    let chrome: OwnedChrome | undefined;
    let page: DevToolsPage | undefined;
    try {
      chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-teambrain-rule-', remoteDebugging: true });
      await withTimeout(ready, 30000, 'TeamBrain browser did not become ready');
      await withTimeout(settingsSeen, 10000, 'Settings request did not arrive');
      page = await connectToPage(chrome, server.url.href);
      await page.evaluate('document.querySelector(\'button[aria-label="Settings"]\').click()');
      await page.settle();
      expect(await page.evaluate('document.querySelector("fieldset.settings-column").disabled')).toBe(true);
      expect(await page.evaluate('!!document.querySelector(".teambrain-cta")')).toBe(false);
      release();
      const deadline = Date.now() + 10000;
      while (await page.evaluate('document.querySelector("fieldset.settings-column").disabled')) {
        if (Date.now() > deadline) throw new Error('Settings did not load');
        await Bun.sleep(10);
      }
      expect(await page.evaluate('document.querySelector(".teambrain-cta")?.getAttribute("href") ?? null'))
        .toBe(shown ? TEAMBRAIN_START_URL : null);
    } finally {
      release(); page?.close(); await chrome?.close(); server.stop(true);
    }
  }, 60000);
}
