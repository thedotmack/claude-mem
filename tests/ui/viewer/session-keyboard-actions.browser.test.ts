import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, chromeExecutablePath, compileBrowserFixture, connectToPage, htmlResponse, launchChrome, scriptResponse,
  type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

for (const key of ['Enter', 'Space'] as const) {
  (chromeExecutablePath ? it : it.skip)(`activates session buttons with native ${key} without opening the card`, async () => {
    const session = { content_session_id: 'owned-session', platform_source: 'claude',
      project: 'owned-project', custom_title: null, item_count: 1, started_at_epoch: Date.now() };
    const bundle = compileBrowserFixture(`
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { SessionCard } from './src/ui/viewer/components/SessionCard';
      window.opens = 0; window.deletes = 0; window.confirm = () => true;
      createRoot(document.getElementById('root')).render(<SessionCard session={${JSON.stringify(session)}}
        onOpen={() => window.opens++} onDelete={async () => { window.deletes++; }} />);
    `);
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      return new URL(request.url).pathname === '/fixture.js' ? scriptResponse(bundle) : htmlResponse(FIXTURE_PAGE_HTML);
    } });
    let chrome: OwnedChrome | undefined;
    let page: DevToolsPage | undefined;
    try {
      chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-session-keyboard-', remoteDebugging: true });
      page = await connectToPage(chrome, server.url.href);
      const { send, evaluate, settle } = page;
      // Headless Chrome hides the page on a native Escape, which stops the
      // animation frames settle() waits for. Focus emulation keeps it visible.
      await send('Emulation.setFocusEmulationEnabled', { enabled: true });
      const press = async (value: 'Enter' | 'Space' | 'Escape') => {
        const code = value === 'Enter' ? 13 : value === 'Space' ? 32 : 27;
        const event = { key: value === 'Space' ? ' ' : value, code: value,
          windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
        const text = value === 'Enter' ? '\r' : value === 'Space' ? ' ' : undefined;
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...event, text, unmodifiedText: text });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
        await settle();
      };
      const renderDeadline = Date.now() + 10000;
      while (!await evaluate('!!document.querySelector(".session-card")')) {
        if (Date.now() > renderDeadline) throw new Error('Session card did not render');
        await Bun.sleep(10);
      }
      await evaluate('document.querySelector(".session-card").focus()'); await press(key);
      const ownCardOpens = await evaluate('window.opens');
      await evaluate('window.opens=0;document.querySelector(".session-card-menu-trigger").focus()');
      await press(key);
      const buttonOpens = await evaluate('window.opens');
      const menuOpened = await evaluate('!!document.querySelector(".session-card-menu")');
      // Keep the later native Delete regression observable even on the broken baseline.
      if (!menuOpened) { await evaluate('document.querySelector(".session-card-menu-trigger").click()'); await settle(); }
      await press('Escape');
      const escaped = await evaluate('!document.querySelector(".session-card-menu")');
      await evaluate('document.querySelector(".session-card-menu-trigger").click()'); await settle();
      await evaluate('window.opens=0;document.querySelector(".session-card-menu-item--danger").focus()');
      await press(key);
      const deleteOpens = await evaluate('window.opens');
      const deletes = await evaluate('window.deletes');
      expect({ ownCardOpens, buttonOpens, menuOpened, deleteOpens, deletes, escaped }).toEqual({
        ownCardOpens: 1, buttonOpens: 0, menuOpened: true, deleteOpens: 0, deletes: 1, escaped: true,
      });
    } finally {
      page?.close(); await chrome?.close(); server.stop(true);
    }
  }, 30000);
}
