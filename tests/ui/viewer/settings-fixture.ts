import {
  compileBrowserFixture, connectToPage, launchChrome, readViewerTemplateStyles,
  scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

export function compileSettingsFixture(script = "fetch('/ready');"): string {
  return compileBrowserFixture(`
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
    ${script}
  `);
}

export function settingsFixtureHtml(): string {
  return '<style>' + readViewerTemplateStyles() + '</style><div id="root"></div><script src="/fixture.js"></script>';
}

export function serveSettingsFixture(options: {
  settings: object | (() => Response | Promise<Response>);
  post: (request: Request) => Response | Promise<Response>;
  script?: string;
  route?: (request: Request) => Response | undefined | Promise<Response | undefined>;
}) {
  const bundle = compileSettingsFixture(options.script);
  const html = settingsFixtureHtml();
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/fixture.js') return scriptResponse(bundle);
    if (path === '/ready') { markReady(); return new Response('ready'); }
    if (path === '/api/settings' && request.method === 'POST') return options.post(request);
    if (path === '/api/settings') return typeof options.settings === 'function'
      ? options.settings() : Response.json(options.settings);
    if (path === '/api/projects') return Response.json({ projects: [], sources: [], projectsBySource: {} });
    return await options.route?.(request) ?? new Response(html, { headers: { 'Content-Type': 'text/html' } });
  } });
  return { server, ready };
}

export async function launchSettingsFixture(url: string, ready: Promise<void>, profilePrefix: string, extraFlags?: string[]) {
  const chrome = launchChrome(url, { profilePrefix, extraFlags, remoteDebugging: true });
  try {
    await withTimeout(ready, 30000, 'Owned browser did not become ready');
    return chrome;
  } catch (error) { await chrome.close(); throw error; }
}

export async function connectLoadedSettings(chrome: OwnedChrome, url: string, timeoutMs = 10000) {
  const page = await connectToPage(chrome, url);
  try {
    const deadline = Date.now() + timeoutMs;
    while (!await page.evaluate('!!document.querySelector(".section-header-btn:not(:disabled)")')) {
      if (Date.now() > deadline) throw new Error('Settings did not load');
      await Bun.sleep(10);
    }
    return page;
  } catch (error) { page.close(); throw error; }
}
