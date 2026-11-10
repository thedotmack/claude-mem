import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, failOnCiWithoutChrome, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { connectLoadedSettings, launchSettingsFixture, serveSettingsFixture } from './settings-fixture';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the native settings-save regression tests.');

(chromeExecutablePath ? it : it.skip)('shows, changes and saves CLAUDE_MEM_CLAUDE_AUTH_METHOD from both Claude branches (#4598)', async () => {
    let posted: any;
    const { server, ready } = serveSettingsFixture({
      settings: { CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'api-key' },
      post: async request => {
        posted = await request.json();
        return Response.json({ success: true });
      },
    });
    let chrome: OwnedChrome | undefined;
    let page: DevToolsPage | undefined;
    try {
      chrome = await launchSettingsFixture(server.url.href, ready, 'claude-mem-auth-method-');
      page = await connectLoadedSettings(chrome, server.url.href);
      const { evaluate, settle } = page;
      const deadline = Date.now() + 10000;
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
