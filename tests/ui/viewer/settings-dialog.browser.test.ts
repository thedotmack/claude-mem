import { expect, it } from 'bun:test';
import {
  chromeExecutablePath, failOnCiWithoutChrome, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';
import { DEFAULT_SETTINGS } from '../../../src/ui/viewer/constants/settings';
import { connectLoadedSettings, launchSettingsFixture, serveSettingsFixture, showSection } from './settings-fixture';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the settings dialog regressions.');

const ESC = '\x1b';
/** A preview as the worker writes it: ANSI codes, three observation rows, and its shortened note above the oldest row kept. */
const PREVIEW = [
  `${ESC}[2mAccess Claude-Mem Rules + Tools: ~/.claude-mem/RULES-AND-TOOLS.md${ESC}[0m`, '',
  `${ESC}[1m${ESC}[36mNov 15, 2026${ESC}[0m`, '',
  `${ESC}[0m\n\n[Terminal preview truncated. The model received the full selected context; additional observations are not shown here.]\n`,
  `  ${ESC}[2m#11${ESC}[0m  ${ESC}[2m5:21 PM${ESC}[0m  🔵  First kept row `,
  `  ${ESC}[2m#12${ESC}[0m           🔵  Second kept row `,
  `  ${ESC}[2m#13${ESC}[0m  ${ESC}[2m5:22 PM${ESC}[0m  🔵  Third kept row `, '',
].join('\n');

const field = (label: string) =>
  `[...document.querySelectorAll('.form-field')].find(x => x.querySelector('.form-field-label')?.textContent === ${JSON.stringify(label)})`;
const setValue = (selector: string, value: string) => `(() => {
  const input = ${selector};
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

/** Waits until `expression` is true in the page, or fails saying what did not happen. */
async function until(page: DevToolsPage, expression: string, what: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!await page.evaluate(expression)) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen`);
    await Bun.sleep(10);
  }
}

/** Chooses `value` in a <select> as a reader does (the change event React listens to). */
const choose = (selector: string, value: string) => `(() => {
  const select = ${selector};
  select.value = ${JSON.stringify(value)};
  select.dispatchEvent(new Event('change', { bubbles: true }));
})()`;

async function pressEscape(page: DevToolsPage) {
  const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  await page.settle();
}

(chromeExecutablePath ? it : it.skip)('says whether anything is unsaved, keeps Save dimmed until something is, and asks in the page before losing changes', async () => {
  const posts: unknown[] = [];
  const { server, ready } = serveSettingsFixture({
    settings: { CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_MEM_CONTEXT_OBSERVATIONS: '40' },
    post: async request => { posts.push(await request.json()); return Response.json({ success: true }); },
  });
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    chrome = await launchSettingsFixture(server.url.href, ready, 'claude-mem-settings-dialog-');
    page = await connectLoadedSettings(chrome, server.url.href);
    const { evaluate, settle, send } = page;
    // Headless Chrome hides the page on a native Escape, which stops the frames settle() waits for.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const observations = `${field('Observations')}.querySelector('input')`;
    const footer = () => evaluate(`({
      changes: document.querySelector('.settings-changes')?.textContent ?? null,
      saveDimmed: document.querySelector('.save-btn').getAttribute('aria-disabled'),
      saveDisabled: document.querySelector('.save-btn').disabled,
    })`);
    const deadline = Date.now() + 10000;
    while (await evaluate(`${observations}.value`) !== '40') {
      if (Date.now() > deadline) throw new Error('Settings did not load');
      await Bun.sleep(10);
    }
    const layout = await evaluate(`({
      tabs: document.querySelectorAll('[role="tab"]').length,
      shownPanels: [...document.querySelectorAll('[role="tabpanel"]')].filter(panel => !panel.hidden).length,
      selected: document.querySelector('[role="tab"][aria-selected="true"] .settings-nav-label').textContent,
    })`);
    const clean = await footer();
    await evaluate('document.querySelector(".save-btn").click()'); await settle();
    const postsAfterDimmedSave = posts.length;

    await evaluate(setValue(observations, '41')); await settle();
    const dirty = await footer();
    await evaluate(setValue(observations, '40')); await settle();
    const undone = await footer();

    await evaluate(setValue(observations, '42')); await settle();
    await evaluate(`${observations}.focus()`);
    await pressEscape(page);
    const asked = await evaluate(`({
      question: document.querySelector('.inline-confirm-question')?.textContent ?? null,
      focus: document.activeElement?.textContent,
      open: !!document.querySelector('.context-settings-modal'),
      closes: window.closes,
    })`);
    await pressEscape(page); // Escape on the question keeps editing.
    const keptEditing = await evaluate(`({
      question: !!document.querySelector('.inline-confirm'),
      open: !!document.querySelector('.context-settings-modal'),
      value: ${observations}.value,
      focusBack: document.activeElement === ${observations},
      closes: window.closes,
    })`);

    await evaluate('document.querySelector(".settings-close-btn").click()'); await settle();
    const askedFromClose = await evaluate(`document.querySelector('.inline-confirm-question')?.textContent ?? null`);
    await evaluate(`[...document.querySelectorAll('.inline-confirm button')].find(b => b.textContent === 'Discard changes').click()`);
    await settle();
    const discarded = await evaluate(`({ open: !!document.querySelector('.context-settings-modal'), closes: window.closes })`);
    await evaluate('window.reopenSettings()'); await settle();
    const reopened = { value: await evaluate(`${observations}.value`), ...(await footer()) };

    expect(layout).toEqual({ tabs: 8, shownPanels: 1, selected: 'Loading' });
    expect(clean).toEqual({ changes: 'No changes to save.', saveDimmed: 'true', saveDisabled: false });
    expect(postsAfterDimmedSave).toBe(0);
    expect(dirty).toEqual({ changes: '1 unsaved change', saveDimmed: null, saveDisabled: false });
    expect(undone).toEqual(clean);
    expect(asked).toEqual({ question: 'Close without saving? Your 1 unsaved change will be lost.', focus: 'Cancel', open: true, closes: 0 });
    expect(keptEditing).toEqual({ question: false, open: true, value: '42', focusBack: true, closes: 0 });
    expect(askedFromClose).toBe('Close without saving? Your 1 unsaved change will be lost.');
    expect(discarded).toEqual({ open: false, closes: 1 });
    expect(reopened).toEqual({ value: '40', ...clean });
    expect(posts).toEqual([]);
  } finally {
    page?.close(); await chrome?.close(); server.stop(true);
  }
}, 80000);

(chromeExecutablePath ? it : it.skip)('shows a secret only while asked, locks read-only fields, and sizes the preview from what it returned', async () => {
  const { server, ready } = serveSettingsFixture({
    settings: { CLAUDE_MEM_PROVIDER: 'gemini', CLAUDE_MEM_GEMINI_API_KEY: 'owned-secret', CLAUDE_CODE_PATH: '/opt/owned/claude' },
    post: () => Response.json({ success: true }),
    projects: { projects: ['owned-project'], sources: ['claude'], projectsBySource: { claude: ['owned-project'] } },
    route: request => new URL(request.url).pathname === '/api/context/preview' ? new Response(PREVIEW) : undefined,
  });
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    chrome = await launchSettingsFixture(server.url.href, ready, 'claude-mem-settings-fields-');
    page = await connectLoadedSettings(chrome, server.url.href);
    const { evaluate, settle } = page;

    await evaluate(showSection('AI provider')); await settle();
    const key = `${field('Gemini API Key')}.querySelector('input')`;
    const toggle = `${field('Gemini API Key')}.querySelector('.field-secret-toggle')`;
    const secret = async () => evaluate(`({ type: ${key}.type, pressed: ${toggle}.getAttribute('aria-pressed'), name: ${toggle}.getAttribute('aria-label') })`);
    const hidden = await secret();
    await evaluate(`${toggle}.click()`); await settle();
    const shown = await secret();
    await evaluate(`${toggle}.click()`); await settle();
    const hiddenAgain = await secret();

    await evaluate(showSection('Advanced')); await settle();
    const cliPath = `${field('Claude Code CLI path')}.querySelector('input')`;
    await evaluate(`${cliPath}.focus()`);
    const readOnly = await evaluate(`({
      readOnly: ${cliPath}.readOnly, value: ${cliPath}.value, lock: !!${cliPath}.parentElement.querySelector('svg'),
      focused: document.activeElement === ${cliPath},
      labelled: document.querySelector('label[for="' + CSS.escape(${cliPath}.id) + '"]')?.textContent,
    })`);

    const deadline = Date.now() + 10000;
    while (!await evaluate('!!document.querySelector(".preview-size")')) {
      if (Date.now() > deadline) throw new Error('Preview did not load');
      await Bun.sleep(10);
    }
    const preview = await evaluate(`({
      size: document.querySelector('.preview-size').textContent,
      note: document.querySelector('.terminal-note span')?.textContent,
      noteInText: document.querySelector('.terminal-text').textContent.includes('Terminal preview truncated'),
      shownText: document.querySelector('.terminal-text').textContent,
      strip: document.querySelector('.terminal-strip-label').textContent,
      wrap: document.querySelector('.terminal-strip-btn').getAttribute('aria-pressed'),
      dots: document.querySelectorAll('.terminal-preview [style*="50%"]').length,
      labelledSelects: [...document.querySelectorAll('.preview-field select')].map(select => document.querySelector('label[for="' + CSS.escape(select.id) + '"]')?.textContent),
      showAll: [...document.querySelectorAll('.terminal-note button')].map(button => button.textContent),
    })`);
    expect(preview.showAll).toEqual(['Show all in the timeline']);
    await evaluate(`document.querySelector('.terminal-note button').click()`);
    await settle();
    const afterShowAll = await evaluate(`({ projects: window.timelineProjects, closes: window.closes })`);

    expect(hidden).toEqual({ type: 'password', pressed: 'false', name: 'Show Gemini API Key' });
    expect(shown).toEqual({ type: 'text', pressed: 'true', name: 'Show Gemini API Key' });
    expect(hiddenAgain).toEqual(hidden);
    expect(readOnly).toEqual({ readOnly: true, value: '/opt/owned/claude', lock: true, focused: true, labelled: 'Claude Code CLI path' });
    // Exact counts of what the preview returned: the text as shown (no ANSI codes, no note) and its three rows.
    expect(preview.size).toBe(`${[...preview.shownText].length} characters · 3 observations shown`);
    expect(preview).toMatchObject({
      note: 'Preview shortened. The model receives the full context; older observations are not shown here.',
      noteInText: false, strip: 'claude · owned-project', wrap: 'true', dots: 0, labelledSelects: ['Source:', 'Project:'],
    });
    expect(afterShowAll).toEqual({ projects: ['owned-project'], closes: 1 });
  } finally {
    page?.close(); await chrome?.close(); server.stop(true);
  }
}, 80000);

/** A preview of `rows` observation rows for `project`, as the worker writes them. */
const previewOf = (project: string, rows: number) => [
  `${ESC}[1m${ESC}[36mNov 15, 2026${ESC}[0m`, '',
  ...Array.from({ length: rows }, (_, index) => `  ${ESC}[2m#${index + 1}${ESC}[0m  ${ESC}[2m5:2${index} PM${ESC}[0m  🔵  ${project} row ${index + 1} `), '',
].join('\n');

(chromeExecutablePath ? it : it.skip)('names the source and project it previews, and never pairs a new choice with the old preview\'s counts', async () => {
  let releaseBeta!: () => void;
  const betaHeld = new Promise<void>(resolve => { releaseBeta = resolve; });
  const previewReads: string[] = [];
  const { server, ready } = serveSettingsFixture({
    settings: { CLAUDE_MEM_PROVIDER: 'codex' },
    post: () => Response.json({ success: true }),
    projects: { projects: ['alpha', 'beta'], sources: ['claude'], projectsBySource: { claude: ['alpha', 'beta'] } },
    route: async request => {
      const url = new URL(request.url);
      if (url.pathname !== '/api/context/preview') return undefined;
      const project = url.searchParams.get('project') ?? '';
      previewReads.push(`${url.searchParams.get('platformSource') ?? 'all'}:${project}`);
      if (project === 'beta') await betaHeld;
      return new Response(previewOf(project, project === 'beta' ? 3 : 2));
    },
  });
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    chrome = await launchSettingsFixture(server.url.href, ready, 'claude-mem-settings-preview-choice-');
    page = await connectLoadedSettings(chrome, server.url.href);
    const { evaluate, settle } = page;
    const look = () => evaluate(`({
      strip: document.querySelector('.terminal-strip-label')?.textContent ?? null,
      size: document.querySelector('.preview-size')?.textContent ?? null,
      loading: document.querySelector('.terminal-loading')?.textContent ?? null,
    })`);
    await until(page, `document.querySelector('.preview-size')?.textContent.endsWith('2 observations')`, 'The first preview');
    const words = await evaluate(`({
      labels: [...document.querySelectorAll('.preview-field label')].map(label => label.textContent),
      firstSource: document.querySelector('.preview-field select').options[0].textContent,
      note: document.querySelector('.settings-preview-note').textContent,
      help: [...document.querySelectorAll('.form-field')].find(f => f.querySelector('.form-field-label')?.textContent === 'Observations').querySelector('.field-help').textContent,
    })`);
    const first = await look();

    // A new project: the strip names it at once, so the size line waits for its own preview.
    await evaluate(choose(`document.querySelectorAll('.preview-field select')[1]`, 'beta'));
    await settle();
    const justChosen = await look();
    const deadline = Date.now() + 10000;
    while (!previewReads.includes('claude:beta')) {
      if (Date.now() > deadline) throw new Error('The beta preview was never read');
      await Bun.sleep(10);
    }
    await settle();
    const whileRead = await look();
    releaseBeta();
    await until(page, `document.querySelector('.preview-size')?.textContent.endsWith('3 observations')`, 'The beta preview');
    const arrived = await look();

    // "All sources" is the empty choice; the strip says it rather than dropping it.
    await evaluate(choose(`document.querySelectorAll('.preview-field select')[0]`, ''));
    await until(page, `!!document.querySelector('.preview-size')`, 'The all-sources preview');
    const allSources = await look();

    expect(words).toEqual({
      labels: ['Source:', 'Project:'], firstSource: 'All sources',
      note: 'Preview the saved configuration for the selected source and project.',
      // The bounds come from SETTING_RANGES (0 to 200 for this field).
      help: 'Number of recent observations to include in context (0-200)',
    });
    expect(first).toEqual({ strip: 'claude · alpha', size: expect.stringMatching(/ characters · 2 observations$/), loading: null });
    expect(justChosen).toEqual({ strip: 'claude · beta', size: null, loading: 'Loading preview...' });
    expect(whileRead).toEqual({ strip: 'claude · beta', size: null, loading: 'Loading preview...' });
    expect(arrived).toEqual({ strip: 'claude · beta', size: expect.stringMatching(/ characters · 3 observations$/), loading: null });
    expect(allSources).toEqual({ strip: 'All sources · beta', size: expect.stringMatching(/ characters · 3 observations$/), loading: null });
  } finally {
    releaseBeta(); page?.close(); await chrome?.close(); server.stop(true);
  }
}, 80000);

(chromeExecutablePath ? it : it.skip)('a cleared field shows, counts and saves the same value: the default for a number, empty for a text', async () => {
  const posts: Record<string, unknown>[] = [];
  const { server, ready } = serveSettingsFixture({
    settings: {
      CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_MODEL: 'owned/model', CLAUDE_MEM_OPENROUTER_APP_NAME: 'owned-app',
      CLAUDE_MEM_BACKUP_INTERVAL_HOURS: '48', CLAUDE_MEM_BACKUP_RETAIN_COUNT: '9', CLAUDE_MEM_WORKER_PORT: '41234',
    },
    post: async request => { posts.push(await request.json()); return Response.json({ success: true }); },
  });
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    chrome = await launchSettingsFixture(server.url.href, ready, 'claude-mem-settings-cleared-');
    page = await connectLoadedSettings(chrome, server.url.href);
    const { evaluate, settle } = page;
    const input = (label: string) => `${field(label)}.querySelector('input')`;
    const cleared: Record<string, unknown> = {};
    for (const [section, label] of [['Backups', 'Interval (hours)'], ['Backups', 'Snapshots to keep'], ['Advanced', 'Worker Port'],
      ['AI provider', 'OpenRouter Model'], ['AI provider', 'App Name (Optional)']] as const) {
      await evaluate(showSection(section)); await settle();
      await evaluate(setValue(input(label), '')); await settle();
      cleared[label] = await evaluate(`({ value: ${input(label)}.value, placeholder: ${input(label)}.placeholder })`);
    }
    const changes = await evaluate(`document.querySelector('.settings-changes').textContent`);
    await evaluate('document.querySelector(".save-btn").click()');
    await until(page, `!!document.querySelector('.save-status .success')`, 'The save');

    expect(cleared).toEqual({
      // A number field puts its default back (the worker's own default for these two)...
      'Interval (hours)': { value: DEFAULT_SETTINGS.CLAUDE_MEM_BACKUP_INTERVAL_HOURS, placeholder: '' },
      'Snapshots to keep': { value: DEFAULT_SETTINGS.CLAUDE_MEM_BACKUP_RETAIN_COUNT, placeholder: '' },
      // ...and the port its saved value: never empty, never the viewer's 37700.
      'Worker Port': { value: '41234', placeholder: '' },
      // A text field stays empty, with the default the worker will use as its placeholder.
      'OpenRouter Model': { value: '', placeholder: `e.g., ${DEFAULT_SETTINGS.CLAUDE_MEM_OPENROUTER_MODEL}` },
      'App Name (Optional)': { value: '', placeholder: DEFAULT_SETTINGS.CLAUDE_MEM_OPENROUTER_APP_NAME },
    });
    expect(changes).toBe('4 unsaved changes');
    expect(posts).toEqual([{
      CLAUDE_MEM_BACKUP_INTERVAL_HOURS: DEFAULT_SETTINGS.CLAUDE_MEM_BACKUP_INTERVAL_HOURS,
      CLAUDE_MEM_BACKUP_RETAIN_COUNT: DEFAULT_SETTINGS.CLAUDE_MEM_BACKUP_RETAIN_COUNT,
      CLAUDE_MEM_OPENROUTER_MODEL: '',
      CLAUDE_MEM_OPENROUTER_APP_NAME: '',
    }]);
  } finally {
    page?.close(); await chrome?.close(); server.stop(true);
  }
}, 80000);

(chromeExecutablePath ? it : it.skip)('a refused save says so with its reason under Details, and the words go once the form is back to no changes or the dialog opens again', async () => {
  let refusals = 0;
  const { server, ready } = serveSettingsFixture({
    settings: { CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_MEM_CONTEXT_OBSERVATIONS: '40' },
    post: () => { refusals++; return Response.json({ error: `Owned refusal ${refusals} ✓` }, { status: 400, statusText: 'Bad Request' }); },
  });
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    chrome = await launchSettingsFixture(server.url.href, ready, 'claude-mem-settings-refused-');
    page = await connectLoadedSettings(chrome, server.url.href);
    const { evaluate, settle } = page;
    const observations = `${field('Observations')}.querySelector('input')`;
    await until(page, `${observations}.value === '40'`, 'Settings load');
    const footer = () => evaluate(`({
      changes: document.querySelector('.settings-changes')?.textContent ?? null,
      failure: document.querySelector('.save-status .error')?.firstChild?.textContent ?? null,
      reason: document.querySelector('.save-status .error pre')?.textContent ?? null,
      folded: document.querySelector('.save-status .error details') ? !document.querySelector('.save-status .error details').open : null,
      saved: !!document.querySelector('.save-status .success'),
    })`);
    const saveAndWait = async (count: number) => {
      await evaluate('document.querySelector(".save-btn").click()');
      const deadline = Date.now() + 10000;
      while (refusals < count || await evaluate('document.querySelector(".save-btn").disabled')) {
        if (Date.now() > deadline) throw new Error('The refused save did not finish');
        await Bun.sleep(10);
      }
      await settle();
    };

    await evaluate(setValue(observations, '41')); await settle();
    await saveAndWait(1);
    const refused = await footer();
    await evaluate(setValue(observations, '40')); await settle();
    const editedBack = await footer();
    await evaluate(setValue(observations, '42')); await settle();
    const editedAgain = await footer();
    await saveAndWait(2);
    const refusedAgain = await footer();
    await evaluate(`document.querySelector('.settings-cancel-btn').click()`); await settle();
    await evaluate(`[...document.querySelectorAll('.inline-confirm button')].find(b => b.textContent === 'Discard changes').click()`); await settle();
    await evaluate('window.reopenSettings()'); await settle();
    const reopened = await footer();

    expect(refused).toEqual({ changes: '1 unsaved change', failure: 'Could not save settings.', reason: '✗ Error: Owned refusal 1 ✓', folded: true, saved: false });
    expect(editedBack).toEqual({ changes: 'No changes to save.', failure: null, reason: null, folded: null, saved: false });
    expect(editedAgain).toEqual({ changes: '1 unsaved change', failure: null, reason: null, folded: null, saved: false });
    expect(refusedAgain).toEqual({ ...refused, reason: '✗ Error: Owned refusal 2 ✓' });
    expect(reopened).toEqual(editedBack);
  } finally {
    page?.close(); await chrome?.close(); server.stop(true);
  }
}, 80000);

(chromeExecutablePath ? it : it.skip)('the section tabs, one sideways row at 1100px and below, fade at the edge with more past it', async () => {
  const { server, ready } = serveSettingsFixture({ settings: { CLAUDE_MEM_PROVIDER: 'codex' }, post: () => Response.json({ success: true }) });
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    chrome = await launchSettingsFixture(server.url.href, ready, 'claude-mem-settings-tab-fade-');
    page = await connectLoadedSettings(chrome, server.url.href);
    const { evaluate, settle, send } = page;
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // A chosen tab's label is bold, so wider than before it was chosen. Placed by its old width, its end sat 2px under
    // the fade on Linux CI ("Backups" and "AI provider", job 133787605151) and 0.4px on a Mac's system font, inside the
    // 1px allowed below. Arial puts those same two tabs there on a Mac, so the tabs are drawn in Arial here.
    await evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>.settings-nav, .settings-nav * { font-family: Arial, sans-serif !important; }</style>')`);
    const row = `document.querySelector('.settings-nav')`;
    const look = () => evaluate(`(() => {
      const nav = ${row}; const style = getComputedStyle(nav);
      return { before: nav.classList.contains('scroll-more-before'), after: nav.classList.contains('scroll-more-after'),
        mask: (style.webkitMaskImage || style.maskImage || 'none') !== 'none', overflows: nav.scrollWidth > nav.clientWidth + 1 };
    })()`);
    const arrowRight = async () => {
      const key = { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      await settle(); await settle();
    };

    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await settle(); await settle();
    const phoneStart = await look();
    // Arrow keys move through the tabs; each focused tab is scrolled clear of a fade (scroll-padding, 56px).
    await evaluate(`${row}.querySelector('[role="tab"]').focus()`); await settle();
    const hidden: string[] = [];
    const tabs = await evaluate(`${row}.querySelectorAll('[role="tab"]').length`);
    for (let index = 1; index < tabs; index++) {
      await arrowRight();
      const placed = await evaluate(`(() => {
        const nav = ${row}.getBoundingClientRect(); const tab = document.activeElement.getBoundingClientRect();
        const classes = ${row}.classList;
        return { name: document.activeElement.querySelector('.settings-nav-label').textContent,
          underEndFade: classes.contains('scroll-more-after') && tab.right > nav.right - 56 + 1,
          underStartFade: classes.contains('scroll-more-before') && tab.left < nav.left + 56 - 1 };
      })()`);
      if (placed.underEndFade || placed.underStartFade) hidden.push(placed.name);
    }
    const phoneEnd = await look();
    await evaluate(`${row}.scrollLeft = 0`); await settle(); await settle();
    const phoneBack = await look();

    await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 800, deviceScaleFactor: 1, mobile: false });
    await settle(); await settle();
    const tablet = await look();

    expect(phoneStart).toEqual({ before: false, after: true, mask: true, overflows: true });
    expect(hidden).toEqual([]);
    // At the last tab the row is at its end: the fade moved to the start.
    expect(phoneEnd).toEqual({ before: true, after: false, mask: true, overflows: true });
    expect(phoneBack).toEqual(phoneStart);
    // The eight tabs fit at 1024px: no fade where nothing is cut.
    expect(tablet).toEqual({ before: false, after: false, mask: false, overflows: false });
  } finally {
    page?.close(); await chrome?.close(); server.stop(true);
  }
}, 80000);

// The tablist announces the direction its tabs are drawn in (aria-orientation): a row at 1100px and below, a column
// above, the template's one breakpoint. Read at 1024 and 1440, then on either side of the breakpoint (1101 and 1100)
// so the script's width and the stylesheet's cannot drift apart, and back at 1440, each after the window changed width.
(chromeExecutablePath ? it : it.skip)('the section tabs announce the orientation they are drawn in: horizontal at 1100px and below, vertical above', async () => {
  const { server, ready } = serveSettingsFixture({ settings: { CLAUDE_MEM_PROVIDER: 'codex' }, post: () => Response.json({ success: true }) });
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  try {
    chrome = await launchSettingsFixture(server.url.href, ready, 'claude-mem-settings-tab-orientation-');
    page = await connectLoadedSettings(chrome, server.url.href);
    const { evaluate, settle, send } = page;
    const announced = `document.querySelector('.settings-nav').getAttribute('aria-orientation')`;
    // What is drawn: every tab on one line is a row; every tab at one left edge is a column.
    const read = () => evaluate(`(() => {
      const tabs = [...document.querySelectorAll('.settings-nav [role="tab"]')].map(tab => tab.getBoundingClientRect());
      const sameTop = tabs.every(box => Math.abs(box.top - tabs[0].top) < 1);
      const sameLeft = tabs.every(box => Math.abs(box.left - tabs[0].left) < 1);
      return { announced: ${announced}, drawn: sameTop && !sameLeft ? 'horizontal' : sameLeft && !sameTop ? 'vertical' : 'mixed' };
    })()`);
    const seen: { width: number; announced: string; drawn: string }[] = [];
    for (const width of [1440, 1024, 1101, 1100, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await settle(); await settle();
      // The attribute follows the media query's change event; give it the file's usual 10 s (until() above), then
      // record what is announced and drawn either way, so a failure shows every width.
      const expected = width <= 1100 ? 'horizontal' : 'vertical';
      const deadline = Date.now() + 10000;
      while (await evaluate(announced) !== expected && Date.now() < deadline) await Bun.sleep(10);
      seen.push({ width, ...await read() });
    }
    expect(seen).toEqual([
      { width: 1440, announced: 'vertical', drawn: 'vertical' },
      { width: 1024, announced: 'horizontal', drawn: 'horizontal' },
      { width: 1101, announced: 'vertical', drawn: 'vertical' },
      { width: 1100, announced: 'horizontal', drawn: 'horizontal' },
      { width: 1440, announced: 'vertical', drawn: 'vertical' },
    ]);
  } finally {
    page?.close(); await chrome?.close(); server.stop(true);
  }
}, 80000);
