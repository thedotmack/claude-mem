import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, failOnCiWithoutChrome, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { connectLoadedSettings, launchSettingsFixture, serveSettingsFixture } from './settings-fixture';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the native settings-save regression tests.');

for (const succeeds of [true, false]) {
  (chromeExecutablePath ? it : it.skip)(`protects the settings draft while an actual ${succeeds ? 'successful' : 'failed'} save is pending`, async () => {
    let posted: any;
    let release!: () => void;
    const responseReady = new Promise<void>(resolve => { release = resolve; });
    const { server, ready } = serveSettingsFixture({
      settings: { CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_MEM_CODEX_MODEL: 'owned-before' },
      post: async request => {
        posted = await request.json(); await responseReady;
        return Response.json(succeeds ? { success: true } : { error: 'Owned rejection' }, { status: succeeds ? 200 : 400 });
      },
    });
    let chrome: OwnedChrome | undefined;
    let page: DevToolsPage | undefined;
    try {
      chrome = await launchSettingsFixture(server.url.href, ready, 'claude-mem-settings-draft-');
      page = await connectLoadedSettings(chrome, server.url.href);
      const { send, evaluate, settle } = page;
      const renderDeadline = Date.now() + 10000;
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
