import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, failOnCiWithoutChrome, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { connectLoadedSettings, launchSettingsFixture, serveSettingsFixture } from './settings-fixture';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the native settings-save regression tests.');

// Image capture is on by default, and "Keep images" is the visible switch that
// turns it off. It sits in a section that is open when Settings opens, shows
// the worker's value, and saves CLAUDE_MEM_MEDIA_CAPTURE_ENABLED as 'false'.
(chromeExecutablePath ? it : it.skip)('shows "Keep images" on without expanding anything and saves turning it off', async () => {
    let posted: any;
    const { server, ready } = serveSettingsFixture({
      settings: { CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'true', CLAUDE_MEM_MEDIA_INFERENCE_ENABLED: 'false' },
      post: async request => {
        posted = await request.json();
        return Response.json({ success: true });
      },
    });
    let chrome: OwnedChrome | undefined;
    let page: DevToolsPage | undefined;
    try {
      chrome = await launchSettingsFixture(server.url.href, ready, 'claude-mem-keep-images-');
      page = await connectLoadedSettings(chrome, server.url.href);
      const { evaluate, settle } = page;
      const deadline = Date.now() + 10000;
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
