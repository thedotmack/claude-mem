import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, failOnCiWithoutChrome, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { connectLoadedSettings, launchSettingsFixture, serveSettingsFixture } from './settings-fixture';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the native settings-save regression tests.');

// An empty CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER means no backup. The viewer shows
// it as Off with the Claude backup fields hidden, saving some other setting
// never writes a backup choice, and 'claude' is saved only when it is chosen.
(chromeExecutablePath ? it : it.skip)('shows an empty quota fallback as Off and saves claude only when it is chosen', async () => {
    const posts: any[] = [];
    const { server, ready } = serveSettingsFixture({
      settings: {
        CLAUDE_MEM_PROVIDER: 'openrouter',
        CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: '',
        CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'true',
      },
      post: async request => {
        posts.push(await request.json());
        return Response.json({ success: true });
      },
    });
    let chrome: OwnedChrome | undefined;
    let page: DevToolsPage | undefined;
    try {
      chrome = await launchSettingsFixture(server.url.href, ready, 'claude-mem-quota-fallback-');
      page = await connectLoadedSettings(chrome, server.url.href);
      const { evaluate, settle } = page;
      const deadline = Date.now() + 10000;
      await evaluate('[...document.querySelectorAll(".section-header-btn")].find(x=>x.textContent.includes("Advanced")).click()');
      await settle();
      const field = (label: string) => `[...document.querySelectorAll(".form-field")].find(x=>x.textContent.startsWith("${label}"))`;
      const quotaSelect = `${field('Quota Fallback')}.querySelector("select")`;
      // The Claude-only sub-form of the backup choice: it exists only for 'claude'.
      const claudeBackupFields = `[...document.querySelectorAll(".form-field")].filter(x=>x.textContent.startsWith("Fallback Claude Model")).length`;
      while (!(await evaluate(`!!${field('Quota Fallback')}`))) {
        if (Date.now() > deadline) throw new Error('Quota Fallback did not render');
        await Bun.sleep(10);
      }
      const saved = async (count: number) => {
        while (posts.length < count || await evaluate('document.querySelector(".save-btn").disabled')) {
          if (Date.now() > deadline) throw new Error('Save did not finish');
          await Bun.sleep(10);
        }
      };

      const loaded = { value: await evaluate(`${quotaSelect}.value`), claudeFields: await evaluate(claudeBackupFields) };

      // Saving an unrelated setting must not write a backup choice.
      await evaluate('document.getElementById("media-capture-enabled").click()');
      await settle();
      await evaluate('document.querySelector(".save-btn").click()');
      await saved(1);
      const unrelatedSave = {
        mediaCapture: posts[0].CLAUDE_MEM_MEDIA_CAPTURE_ENABLED,
        savedBackup: 'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER' in posts[0],
      };

      // Choosing Claude shows its fields and saves it.
      const choose = (value: string) => evaluate(`(() => { const s = ${quotaSelect}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '${value}'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await choose('claude');
      await settle();
      const chosen = { value: await evaluate(`${quotaSelect}.value`), claudeFields: await evaluate(claudeBackupFields) };
      await evaluate('document.querySelector(".save-btn").click()');
      await saved(2);
      const claudeSave = posts[1].CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER;

      // Switching back to Off hides them again.
      await choose('off');
      await settle();
      const backOff = { value: await evaluate(`${quotaSelect}.value`), claudeFields: await evaluate(claudeBackupFields) };

      expect({ loaded, unrelatedSave, chosen, claudeSave, backOff }).toEqual({
        loaded: { value: 'off', claudeFields: 0 },
        unrelatedSave: { mediaCapture: 'false', savedBackup: false },
        chosen: { value: 'claude', claudeFields: 1 },
        claudeSave: 'claude',
        backOff: { value: 'off', claudeFields: 0 },
      });
    } finally {
      page?.close(); await chrome?.close(); server.stop(true);
    }
}, 80000);
