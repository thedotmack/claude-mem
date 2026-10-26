import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, compileBrowserFixture, connectToPage, failOnCiWithoutChrome, launchChrome, readViewerTemplateStyles,
  scriptResponse, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the native settings-save regression tests.');

for (const succeeds of [true, false]) {
  (chromeExecutablePath ? it : it.skip)(`protects the settings draft while an actual ${succeeds ? 'successful' : 'failed'} save is pending`, async () => {
    let posted: any;
    let release!: () => void;
    const responseReady = new Promise<void>(resolve => { release = resolve; });
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
        posted = await request.json(); await responseReady;
        return Response.json(succeeds ? { success: true } : { error: 'Owned rejection' }, { status: succeeds ? 200 : 400 });
      }
      if (path === '/api/settings') return Response.json({ CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_MEM_CODEX_MODEL: 'owned-before' });
      if (path === '/api/projects') return Response.json({ projects: [], sources: [], projectsBySource: {} });
      return new Response('<style>' + styles + '</style><div id="root"></div><script src="/fixture.js"></script>', { headers: { 'Content-Type': 'text/html' } });
    } });
    let chrome: OwnedChrome | undefined;
    let page: DevToolsPage | undefined;
    try {
      chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-settings-draft-', remoteDebugging: true });
      // Separate Chrome's cold start from the settings steps. Chrome writes
      // DevToolsActivePort before it loads the page, so it exists by now.
      await withTimeout(ready, 30000, 'Owned browser did not become ready');
      page = await connectToPage(chrome, server.url.href);
      const { send, evaluate, settle } = page;
      const renderDeadline = Date.now() + 10000;
      // The section toggles sit in the fieldset, which stays disabled until
      // the settings load; a click before then would be ignored.
      while (!await evaluate('!!document.querySelector(".section-header-btn:not(:disabled)")')) {
        if (Date.now() > renderDeadline) throw new Error('Settings did not load');
        await Bun.sleep(10);
      }
      await evaluate('[...document.querySelectorAll(".section-header-btn")].find(x=>x.textContent.includes("Advanced")).click()');
      await settle();
      const model = '[...document.querySelectorAll(".form-field")].find(x=>x.textContent.startsWith("Codex Model")).querySelector("input")';
      while (!await evaluate(`${model}.value === 'owned-before'`)) {
        if (Date.now() > renderDeadline) throw new Error('Settings did not load');
        await Bun.sleep(10);
      }
      await evaluate(`${model}.focus();${model}.select()`);
      await send('Input.insertText', { text: 'owned-A' }); await settle();
      expect(await evaluate(`${model}.value`)).toBe('owned-A');
      await evaluate('document.querySelector(".save-btn").click()');
      const saveDeadline = Date.now() + 10000;
      while (!posted || !await evaluate('document.querySelector(".save-btn").disabled')) {
        if (Date.now() > saveDeadline) throw new Error('Save did not reach owned endpoint');
        await Bun.sleep(10);
      }
      const panelPadding = await evaluate('getComputedStyle(document.querySelector(".settings-column")).padding');
      const disabledDuring = await evaluate(`${model}.matches(':disabled')`);
      await evaluate(`${model}.focus();${model}.select()`);
      await send('Input.insertText', { text: 'owned-B' }); await settle();
      const pendingValue = await evaluate(`${model}.value`);
      const toggleDisabled = await evaluate('document.querySelector("#show-last-summary").matches(":disabled")');
      release();
      while (await evaluate('document.querySelector(".save-btn").disabled')) {
        if (Date.now() > saveDeadline) throw new Error('Save did not finish');
        await Bun.sleep(10);
      }
      const finishedValue = await evaluate(`${model}.value`);
      const enabledAfter = await evaluate(`!${model}.matches(':disabled')`);
      await evaluate(`${model}.focus();${model}.select()`);
      await send('Input.insertText', { text: 'owned-C' }); await settle();
      const editableAfter = await evaluate(`${model}.value`);
      expect({
        postedValue: posted.CLAUDE_MEM_CODEX_MODEL, panelPadding, disabledDuring, pendingValue,
        toggleDisabled, finishedValue, enabledAfter, editableAfter,
      }).toEqual({
        postedValue: 'owned-A', panelPadding: '0px', disabledDuring: true, pendingValue: 'owned-A',
        toggleDisabled: true, finishedValue: 'owned-A', enabledAfter: true, editableAfter: 'owned-C',
      });
    } finally {
      release(); page?.close(); await chrome?.close(); server.stop(true);
    }
  }, 80000);
}
