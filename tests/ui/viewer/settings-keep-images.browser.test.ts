import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, compileBrowserFixture, connectToPage, failOnCiWithoutChrome, launchChrome, readViewerTemplateStyles,
  scriptResponse, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the native settings-save regression tests.');

// Image capture is on by default, and "Keep images" is the visible switch that
// turns it off. It sits in a section that is open when Settings opens, shows
// the worker's value, and saves CLAUDE_MEM_MEDIA_CAPTURE_ENABLED as 'false'.
(chromeExecutablePath ? it : it.skip)('shows "Keep images" on without expanding anything and saves turning it off', async () => {
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
      if (path === '/api/settings') return Response.json({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'true', CLAUDE_MEM_MEDIA_INFERENCE_ENABLED: 'false' });
      if (path === '/api/projects') return Response.json({ projects: [], sources: [], projectsBySource: {} });
      return new Response('<style>' + styles + '</style><div id="root"></div><script src="/fixture.js"></script>', { headers: { 'Content-Type': 'text/html' } });
    } });
    let chrome: OwnedChrome | undefined;
    let page: DevToolsPage | undefined;
    try {
      chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-keep-images-', remoteDebugging: true });
      await withTimeout(ready, 30000, 'Owned browser did not become ready');
      page = await connectToPage(chrome, server.url.href);
      const { evaluate, settle } = page;
      const deadline = Date.now() + 10000;
      while (!await evaluate('!!document.querySelector(".section-header-btn:not(:disabled)")')) {
        if (Date.now() > deadline) throw new Error('Settings did not load');
        await Bun.sleep(10);
      }
      const keepImages = 'document.getElementById("media-capture-enabled")';
      const shown = await evaluate(`(() => {
        const el = ${keepImages};
        if (!el) return null;
        const row = el.closest('.toggle-row');
        return {
          checked: el.getAttribute('aria-checked'),
          label: row.querySelector('.toggle-label').textContent,
          description: row.querySelector('.toggle-description').textContent,
          visible: el.getBoundingClientRect().height > 0,
          sectionOpen: el.closest('.settings-section-collapsible').classList.contains('open'),
        };
      })()`);
      await evaluate(`${keepImages}.click()`);
      await settle();
      const afterClick = await evaluate(`${keepImages}.getAttribute('aria-checked')`);
      await evaluate('document.querySelector(".save-btn").click()');
      while (!posted) {
        if (Date.now() > deadline) throw new Error('Save did not reach owned endpoint');
        await Bun.sleep(10);
      }
      expect(shown).toMatchObject({ checked: 'true', label: 'Keep images', visible: true, sectionOpen: true });
      expect(shown.description).toContain('until their event is deleted');
      expect(shown.description).toContain('never sends images to an AI model');
      expect(afterClick).toBe('false');
      expect(posted.CLAUDE_MEM_MEDIA_CAPTURE_ENABLED).toBe('false');
      // Turning capture off never turns inference on.
      expect(posted.CLAUDE_MEM_MEDIA_INFERENCE_ENABLED ?? 'false').toBe('false');
    } finally {
      page?.close(); await chrome?.close(); server.stop(true);
    }
}, 60000);
