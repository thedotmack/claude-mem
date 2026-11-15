import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, chromeExecutablePath, compileBrowserFixture, connectToPage, htmlResponse, launchChrome, scriptResponse,
  type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

for (const key of ['Enter', 'Space'] as const) {
  (chromeExecutablePath ? it : it.skip)(`toggles session actions with a pointer and activates focused controls with ${key}`, async () => {
    const session = { content_session_id: 'owned-session', platform_source: 'claude',
      project: 'owned-project', custom_title: null, item_count: 1, started_at_epoch: Date.now() };
    const bundle = compileBrowserFixture(`
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { SessionCard } from './src/ui/viewer/components/SessionCard';
      window.opens = 0; window.deletes = 0; window.confirm = () => true;
      createRoot(document.getElementById('root')).render(<>
        <button id="outside">Outside</button>
        <SessionCard session={${JSON.stringify(session)}}
          onOpen={() => window.opens++} onDelete={async () => { window.deletes++; }} />
      </>);
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
      const click = async (selector: string) => {
        const { x, y } = await evaluate(`(() => {
          const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        await settle();
      };
      const renderDeadline = Date.now() + 10000;
      while (!await evaluate('!!document.querySelector(".session-card")')) {
        if (Date.now() > renderDeadline) throw new Error('Session card did not render');
        await Bun.sleep(10);
      }
      const triggerIcon = '.session-card-menu-trigger circle:first-child';
      const hasMenu = () => evaluate('!!document.querySelector(".session-card-menu")');
      await click(triggerIcon);
      const clickedOpen = await hasMenu();
      await click(triggerIcon);
      const clickedClosed = !await hasMenu();
      // Put both the baseline and the fixed UI in the same state before testing outside dismissal.
      if (clickedClosed) await click(triggerIcon);
      await click('#outside');
      const outsideClosed = !await hasMenu();
      const outsideFocused = await evaluate('document.activeElement.id === "outside"');

      await evaluate('document.querySelector(".session-card").focus()'); await press(key);
      const ownCardOpens = await evaluate('window.opens');
      await evaluate('window.opens=0;document.querySelector(".session-card-menu-trigger").focus()');
      await press(key);
      const buttonOpens = await evaluate('window.opens');
      const menuOpened = await hasMenu();
      // Keep the later native Delete regression observable even on the broken baseline.
      if (!menuOpened) { await evaluate('document.querySelector(".session-card-menu-trigger").click()'); await settle(); }
      await evaluate('document.querySelector(".session-card-menu-item").focus()');
      await press('Escape');
      const escaped = !await hasMenu();
      const restoredFocus = await evaluate('document.activeElement === document.querySelector(".session-card-menu-trigger")');
      await evaluate('document.querySelector(".session-card-menu-trigger").click()'); await settle();
      await evaluate('window.opens=0;document.querySelector(".session-card-menu-item--danger").focus()');
      await press(key);
      const deleteOpens = await evaluate('window.opens');
      const deletes = await evaluate('window.deletes');
      expect({ clickedOpen, clickedClosed, outsideClosed, outsideFocused, ownCardOpens, buttonOpens,
        menuOpened, deleteOpens, deletes, escaped, restoredFocus }).toEqual({
        clickedOpen: true, clickedClosed: true, outsideClosed: true, outsideFocused: true,
        ownCardOpens: 1, buttonOpens: 0, menuOpened: true, deleteOpens: 0, deletes: 1, escaped: true, restoredFocus: true,
      });
    } finally {
      page?.close(); await chrome?.close(); server.stop(true);
    }
  }, 30000);
}
