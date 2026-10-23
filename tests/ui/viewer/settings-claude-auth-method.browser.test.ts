import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, compileBrowserFixture, connectToPage, failOnCiWithoutChrome, launchChrome, readViewerTemplateStyles,
  scriptResponse, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the native settings-save regression tests.');

(chromeExecutablePath ? it : it.skip)('shows, changes and saves CLAUDE_MEM_CLAUDE_AUTH_METHOD from both Claude branches (#4598)', async () => {
    let posted: any;
    const bundle = compileBrowserFixture(`
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ContextSettingsModal } from './src/ui/viewer/components/ContextSettingsModal';
        import { useSettings } from './src/ui/viewer/hooks/useSettings';
        function Fixture() {
          const state = useSettings();
          return <ContextSettingsModal isOpen={true} onClose={() => {}} onSave={state.saveSettings}
            settings={state.settings} isLoaded={state.isLoaded} loadError={state.loadError}
            onRetryLoad={state.reload} isSaving={state.isSaving} saveStatus={state.saveStatus} />;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
        fetch('/ready');
      `);
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    const styles = readViewerTemplateStyles();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/fixture.js') return scriptResponse(bundle);
      if (path === '/ready') { markReady(); return new Response('ready'); }
      if (path === '/api/settings' && request.method === 'POST') {
        posted = await request.json();
        return Response.json({ success: true });
      }
      if (path === '/api/settings') return Response.json({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'api-key' });
      if (path === '/api/projects') return Response.json({ projects: [], sources: [], projectsBySource: {} });
      return new Response('<style>' + styles + '</style><div id="root"></div><script src="/fixture.js"></script>', { headers: { 'Content-Type': 'text/html' } });
    } });
    let chrome: OwnedChrome | undefined;
    let page: DevToolsPage | undefined;
    try {
      chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-auth-method-', remoteDebugging: true });
      // Separate Chrome's cold start from the settings steps. Chrome writes
      // DevToolsActivePort before it loads the page, so it exists by now.
      await withTimeout(ready, 30000, 'Owned browser did not become ready');
      page = await connectToPage(chrome, server.url.href);
      const { send, evaluate, settle } = page;
      const deadline = Date.now() + 10000;
      while (!await evaluate('!!document.querySelector(".section-header-btn:not(:disabled)")')) {
        if (Date.now() > deadline) throw new Error('Settings did not load');
        await Bun.sleep(10);
      }
      await evaluate('[...document.querySelectorAll(".section-header-btn")].find(x=>x.textContent.includes("Advanced")).click()');
      await settle();
      const authSelects = '[...document.querySelectorAll(".form-field")].filter(x=>x.textContent.startsWith("Claude Auth Method")).map(x=>x.querySelector("select"))';
      // The provider dropdowns' Claude options (other selects also carry a "claude" value, e.g. source filters).
      const claudeLabels = '[...document.querySelectorAll(\'option[value="claude"]\')].map(o=>o.textContent).filter(t=>t.startsWith("Claude ("))';
      while ((await evaluate(`${authSelects}.length`)) !== 2) {
        if (Date.now() > deadline) throw new Error('Auth method selects did not render');
        await Bun.sleep(10);
      }
      const loaded = { values: await evaluate(`${authSelects}.map(s=>s.value)`), labels: await evaluate(claudeLabels) };
      // Change the FALLBACK select: both selects and both labels follow the one setting.
      await evaluate(`(() => { const s = ${authSelects}[1]; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'gateway'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await settle();
      const changed = { values: await evaluate(`${authSelects}.map(s=>s.value)`), labels: await evaluate(claudeLabels) };
      await evaluate('document.querySelector(".save-btn").click()');
      while (!posted) {
        if (Date.now() > deadline) throw new Error('Save did not reach owned endpoint');
        await Bun.sleep(10);
      }
      expect({ loaded, changed, saved: posted.CLAUDE_MEM_CLAUDE_AUTH_METHOD }).toEqual({
        loaded: { values: ['api-key', 'api-key'], labels: ['Claude (uses an API key)', 'Claude (uses an API key)'] },
        changed: { values: ['gateway', 'gateway'], labels: ['Claude (via a gateway)', 'Claude (via a gateway)'] },
        saved: 'gateway',
      });
    } finally {
      page?.close(); await chrome?.close(); server.stop(true);
    }
  }, 80000);
