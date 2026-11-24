import { afterEach, describe, expect, it } from 'bun:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { RevealSets } from '../../../src/ui/my-work/src/setup/setup-reveal';

// Compile the real component and source together: no DOM package or paid service is needed.
const compiled = buildSync({
  stdin: {
    resolveDir: resolve(import.meta.dir, '../../../src/ui/my-work'), loader: 'tsx', contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { ScanScreen } from './src/setup/screens/scan-screen';
      import { RevealScreen } from './src/setup/screens/reveal-screen';
      import { InstallScreen } from './src/setup/screens/install-screen';
      export const renderReveal = (agents, reveal, extraction, uploadedAgents = null, hostedNotice = null, skipped = false, options = {}) => renderToStaticMarkup(<RevealScreen agents={agents} reveal={reveal} extraction={extraction} uploadedAgents={uploadedAgents} recentPrompts={[]} hostedNotice={hostedNotice} skipped={skipped} onContinue={() => {}} {...options} />);
      export { localSetupSource, EMPTY_SETUP_DATA, setupPending, setupToolsForInstall, toSetupFailure, SetupRequestError, connectionFailureAbove } from './src/setup/setup-data';
      export const renderInstall = (install) => renderToStaticMarkup(<InstallScreen install={install} onInstall={async () => {}} />);
      export { SAMPLE_REQUESTS } from './src/data';
      export { SAMPLE_FOCUS_AREAS } from './src/data-goals';
      export const renderScan = (scan, preferenceError = null, retrying = false, retryError = null, consentError = null, consentSending = false) => renderToStaticMarkup(
        <ScanScreen scan={scan} onImproveProductChange={() => {}} onConfirmUpload={() => {}} consentError={consentError} consentSending={consentSending} preferenceError={preferenceError} onRetry={() => {}} retrying={retrying} retryError={retryError} />
      );
    `,
  },
  tsconfig: resolve(import.meta.dir, '../../../src/ui/my-work/tsconfig.app.json'),
  bundle: true, write: false, format: 'cjs', platform: 'node',
  loader: { '.webp': 'dataurl', '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
}).outputFiles[0].text;

function fixture() {
  const module = { exports: {} as any };
  new Function('module', 'exports', 'require', compiled)(module, module.exports, createRequire(import.meta.url));
  return module.exports;
}

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.EventSource = originalEventSource; });

class Stream extends EventTarget {
  static latest: Stream;
  closed = false;
  constructor() { super(); Stream.latest = this; }
  close() { this.closed = true; }
  send(name: string, data: unknown) { this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) })); }
}
const scan = (changes = {}) => ({ agents: [], percent: 0, phase: 'idle', done: false, error: null, improveProduct: true, ...changes });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function until(check: () => boolean) {
  // Bound fixture waits so a missing source callback fails the test instead of hanging the suite.
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Expected setup source update was not received.');
    await settle();
  }
}
function useNetwork(handle: (url: string, init: RequestInit) => Promise<Response> | Response) {
  globalThis.EventSource = Stream as unknown as typeof EventSource;
  globalThis.fetch = ((url, init = {}) => handle(String(url), init)) as typeof fetch;
}

const installState = (status = 'waiting') => ({
  status, error: null, selection: null,
  catalog: {
    agents: [
      { id: 'claude-code', label: 'Claude Code', hint: 'recommended', detected: false },
      { id: 'cursor', label: 'Cursor', hint: 'Hooks and MCP', detected: true },
      { id: 'codex-cli', label: 'Codex CLI', hint: 'Native hooks', detected: true },
    ],
    skills: [{ id: 'how-it-works', label: 'How it works', description: 'Understand your memory.', required: true }],
    defaults: { agents: ['cursor', 'codex-cli'], skills: ['how-it-works'], installClaudeCode: false, disableAutoMemory: false, telemetryEnabled: true, claudeModel: 'haiku' },
    reinstall: false,
  },
});

describe('browser installation', () => {
  it('shows actual agents, optional preferences and a selectable installation before scanning', () => {
    const app = fixture();
    const html = app.renderInstall(installState());
    expect(html).toContain('Give your agents memory');
    expect(html).toContain('Cursor');
    expect(html).toContain('Codex CLI');
    expect(html).toContain('Skills and preferences');
    expect(html).toContain('Claude model');
    expect(html).toContain('Set up my agents');
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="cursor"/);
    expect(html).not.toContain('Install Claude Code too');
  });

  it('keeps configured integration ids and marks every installed agent connected', () => {
    const app = fixture();
    const state = installState('ready');
    state.selection = state.catalog.defaults as any;
    const tools = app.setupToolsForInstall(state);
    expect(tools.filter((tool: any) => tool.installed).map((tool: any) => tool.id)).toEqual(['cursor', 'codex-cli']);
    expect(tools.some((tool: any) => tool.id === 'chatgpt')).toBe(true);
  });

  it('shows install failures with an explicit retry and respects environment skill controls', () => {
    const app = fixture();
    const state = installState('failed');
    state.error = 'Cursor configuration could not be saved.' as any;
    Object.assign(state.catalog, { skillsLocked: true });
    const html = app.renderInstall(state);
    expect(html).toContain('Cursor configuration could not be saved.');
    expect(html).toContain('Try installation again');
    expect(html).toContain('Your environment controls skill selection.');
    expect(html).toContain('<fieldset disabled="">');
  });

  it('does not replace ready integrations with a stale initial state response', async () => {
    const app = fixture();
    const initialState = deferred<Response>();
    let started = 0;
    useNetwork((url, init) => {
      if (url === '/api/setup/state') return initialState.promise;
      if (url === '/api/setup/scan') {
        if (init.method === 'POST') started++;
        return Response.json(scan(init.method === 'POST' ? { phase: 'reading' } : {}));
      }
      return Response.json({});
    });
    let latest: any;
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    Stream.latest.send('setup-state', { status: 'pending', alreadyPro: false, install: { ...installState('ready'), selection: installState().catalog.defaults } });
    initialState.resolve(Response.json({ status: 'pending', alreadyPro: false, install: installState() }));
    await until(() => started === 1);
    expect(latest.install.status).toBe('ready');
    stop();
  });

  it('retains the saved Home choice and recovers a failed resume without failing the scan', async () => {
    const app = fixture();
    const home = { branch: 'home', memoryBilling: 'existing' };
    let failResume = true;
    let scansStarted = 0;
    let latest: any;
    useNetwork((url, init) => {
      if (url === '/api/setup/state') return Response.json({ status: 'pending', alreadyPro: false, choice: home, install: installState() });
      if (url === '/api/setup/resume') return failResume ? Response.json({ error: 'Could not start setup.' }, { status: 503 }) : Response.json({ success: true });
      if (url === '/api/setup/scan') {
        if (init.method === 'POST') scansStarted++;
        return Response.json(scan(init.method === 'POST' ? { phase: 'reading' } : {}));
      }
      return Response.json({ success: true });
    });
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    await until(() => latest?.connectionError === 'Could not start setup.');
    // The worker answered the resume with a refusal: the page words it as one, not as "can't reach".
    expect(latest.connectionErrorKind).toBe('refused');
    expect(latest.choice).toEqual(home);
    expect(latest.scan.phase).toBe('idle');
    expect(latest.scan.error).toBeNull();
    failResume = false;
    await app.localSetupSource.resume();
    expect(latest.connectionError).toBeNull();
    expect(latest.connectionErrorKind).toBeNull();
    expect(latest.scan.phase).toBe('idle');
    Stream.latest.send('setup-state', { status: 'pending', alreadyPro: false, choice: home, install: { ...installState('ready'), selection: installState().catalog.defaults } });
    await until(() => scansStarted === 1 && latest.scan.phase === 'reading');
    expect(latest.scan.phase).toBe('reading');
    stop();
  });

  it('clears a failed startup connection when saving the installation succeeds', async () => {
    const app = fixture();
    let latest: any;
    useNetwork((url, init) => {
      if (url === '/api/setup/state') return Response.json({ status: 'pending', alreadyPro: false, install: installState() });
      if (url === '/api/setup/resume') return Response.json({ error: 'Installer unavailable.' }, { status: 503 });
      if (url === '/api/setup/scan') return Response.json(scan());
      return Response.json({ success: true });
    });
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    await until(() => latest?.connectionError === 'Installer unavailable.');
    await app.localSetupSource.configureInstall(installState().catalog.defaults);
    expect(latest.connectionError).toBeNull();
    expect(latest.scan.phase).toBe('idle');
    stop();
  });

  it('opens first-use setup only for an explicit unfinished install handoff', async () => {
    const app = fixture();
    for (const [state, expected] of [[{ status: 'pending' }, false], [{ status: 'pending', install: installState() }, true], [{ status: 'complete', install: installState('ready') }, false]] as const) {
      useNetwork(() => Response.json(state));
      expect(await app.setupPending()).toBe(expected);
    }
  });

  it('defers scanning until the selected integrations are ready and resumes a detached installer', async () => {
    const app = fixture();
    const calls: string[] = [];
    const resumeRequests: unknown[] = [];
    const selection = installState().catalog.defaults;
    let latest: any;
    useNetwork((url, init) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (url === '/api/setup/state') return Response.json({ status: 'pending', alreadyPro: false, install: installState() });
      if (url === '/api/setup/resume') { resumeRequests.push(JSON.parse(String(init.body))); return Response.json({ success: true }); }
      if (url === '/api/setup/install') {
        expect(JSON.parse(String(init.body))).toEqual(selection);
        return Response.json({ success: true });
      }
      if (url === '/api/setup/scan') return Response.json(scan(init.method === 'POST' ? { phase: 'reading' } : {}));
      return Response.json({});
    });
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    await until(() => calls.includes('POST /api/setup/resume'));
    await settle();
    expect(calls).not.toContain('POST /api/setup/scan');
    expect(resumeRequests).toEqual([{}]);
    await app.localSetupSource.resume();
    expect(resumeRequests).toEqual([{}, { retry: true }]);
    await app.localSetupSource.configureInstall(selection);
    Stream.latest.send('setup-state', { status: 'pending', alreadyPro: false, install: { ...installState('ready'), selection } });
    await until(() => calls.includes('POST /api/setup/scan'));
    expect(latest.install.selection.agents).toEqual(['cursor', 'codex-cli']);
    stop();
  });
});

describe('hosted setup scan control', () => {
  it('prechecks usage statistics under the progress meter, and locks it only for upload', () => {
    const app = fixture();
    const initial = app.renderScan(app.EMPTY_SETUP_DATA.scan);
    const checkbox = initial.match(/<input[^>]+type="checkbox"[^>]*>/)?.[0] ?? '';
    expect(checkbox).toContain('checked=""');
    expect(checkbox).not.toContain('disabled');
    expect(initial).toContain('Share anonymous usage statistics to help improve your Claude-mem experience');
    expect(initial.indexOf('<progress')).toBeLessThan(initial.indexOf(checkbox));
    expect(app.renderScan(scan({ phase: 'reading', improveProduct: true }))).toContain('checked=""');
    expect(app.renderScan(scan({ phase: 'reading', improveProduct: false }))).not.toContain('checked=""');
    expect(initial).not.toContain('Find my focus areas');
    const consent = app.renderScan(scan({ phase: 'awaiting-consent', agents: [{ id: 'codex', label: 'Codex', detected: true, prompts: 3 }] }));
    expect(consent).toContain('Find my focus areas');
    expect(consent).toContain('Include recent conversations');
    expect(consent).not.toContain('Skip the scan');
    // The shared Button carries "disabled:" in its classes, so look at the Discover button's own attributes. A missing
    // button fails here, so the checks below can never pass on an empty match.
    const discover = (html: string) => {
      const button = html.match(/<button[^>]*>Find my focus areas[^<]*</)?.[0];
      if (!button) throw new Error('The Discover button is missing');
      return button;
    };
    const undetected = app.renderScan(scan({ phase: 'awaiting-consent', agents: [{ id: 'claude-code', label: 'Claude Code', detected: false, prompts: 2, canRunSetup: null, cannotRunReason: null }] }));
    expect(undetected).toContain('Claude Code (2 messages)');
    expect(discover(undetected)).not.toContain('aria-disabled="true"');
    const sending = app.renderScan(scan({ phase: 'awaiting-consent', agents: [{ id: 'codex', label: 'Codex', detected: true, prompts: 3, canRunSetup: null, cannotRunReason: null }] }), null, false, null, null, true);
    expect(sending).toContain('Sending your choice');
    expect(discover(sending)).toContain('aria-disabled="true"');
    const refusedConsent = app.renderScan(scan({ phase: 'awaiting-consent' }), null, false, null, { kind: 'refused', detail: 'Could not send your choice' });
    expect(refusedConsent).toContain('role="alert"');
    expect(refusedConsent).toContain('Couldn’t send your choice.');
    expect(refusedConsent).toContain('your prompts may already have been uploaded');
    expect(refusedConsent).toContain('<pre>Could not send your choice</pre>');
    expect(app.renderScan(scan({ phase: 'awaiting-consent', agents: [{ id: 'codex', label: 'Codex', detected: true, prompts: 3, canRunSetup: null, cannotRunReason: null }] }))).toContain('Codex (3 messages)');
    // The upload details are folded: kept in the markup, closed until opened.
    const visibleConsent = consent.replace(/<div data-state="closed"[^>]*data-slot="collapsible-content"[^>]*>[\s\S]*?<\/div>/g, '');
    expect(visibleConsent).toContain('Claude-Mem uses the last 30 days of conversations to find your projects and preferences.');
    expect(visibleConsent).toContain('Selected messages are sent to cmem.ai and an AI provider.');
    expect(visibleConsent).not.toContain('session IDs');
    expect(visibleConsent).not.toContain('timestamps');
    expect(consent).toContain('What gets uploaded?');
    expect(consent).toContain('The full text of your messages from the last 30 days in the selected tools');
    expect(consent).toContain('session IDs, project names, folder paths and timestamps');
    expect(app.renderScan(scan({ phase: 'saving' }))).not.toContain('disabled=""');
    expect(app.renderScan(scan({ phase: 'uploading' }))).toContain('disabled=""');
  });

  it('shows one forward action for the selected conversations and for starting with new work', () => {
    const app = fixture();
    const populated = app.renderScan(scan({ phase: 'awaiting-consent', agents: [{ id: 'codex', label: 'Codex', detected: true, prompts: 3 }] }));
    expect(populated).toMatch(/<button[^>]*class="[^"]*primary"[^>]*>Find my focus areas/);
    expect(populated).not.toContain('Skip the scan');
    const empty = app.renderScan(scan({ phase: 'awaiting-consent', agents: [] }));
    expect(empty).toMatch(/<button[^>]*class="[^"]*primary"[^>]*>Continue with new work/);
  });

  it('explains how to reduce an oversized upload and keeps the inclusion control available', () => {
    const app = fixture();
    const agent = (id: string, uploadBytes: number) => ({ id, label: id, detected: true, prompts: 3, canRunSetup: null, cannotRunReason: null, uploadBytes });
    const button = (html: string, label: string) => {
      const found = html.match(new RegExp(`<button[^>]*>${label}[^<]*<`))?.[0];
      if (!found) throw new Error(`The ${label} button is missing`);
      return found;
    };
    const halfCap = 1024 * 1024;
    const fits = app.renderScan(scan({ phase: 'awaiting-consent', agents: [agent('codex', halfCap), agent('claude-code', halfCap)] }));
    expect(fits).not.toContain('Choose fewer tools');
    expect(button(fits, 'Find my focus areas')).not.toContain('aria-disabled="true"');
    const over = app.renderScan(scan({ phase: 'awaiting-consent', agents: [agent('codex', halfCap), agent('claude-code', halfCap + 1)] }));
    expect(over).toContain('id="setup-waiting-line" class="setup-waiting">Choose fewer tools or turn off recent conversations to continue.');
    expect(button(over, 'Find my focus areas')).toContain('aria-disabled="true"');
    expect(button(over, 'Find my focus areas')).toContain('aria-describedby="setup-waiting-line"');
    expect(over).toContain('Include recent conversations');
  });

  it('shows the skipped-step message only when the person actually skipped', () => {
    const app = fixture();
    const agents = [{ id: 'codex', label: 'Codex', detected: true, prompts: 3, canRunSetup: null, cannotRunReason: null }];
    const empty = { goals: [], work: [], rules: [] };
    const local = app.renderReveal(agents, empty, { state: 'ok', step: null }, []);
    expect(local).toContain('Your agents can build memory as you work.');
    expect(local).not.toContain('Your recent work');
    // An upload that came back with nothing must never be described as "nothing was uploaded".
    const uploadedEmpty = app.renderReveal(agents, empty, { state: 'ok', step: null }, ['codex']);
    expect(uploadedEmpty).not.toContain('Your agents can build memory as you work.');
    expect(uploadedEmpty).not.toContain('Nothing was uploaded');
    expect(app.renderReveal(agents, { goals: null, work: null, rules: null }, { state: 'running', step: 'goals' }, ['codex'])).toContain('Your recent work');
  });

  it('shows installed agents and the trial on a completed empty scan, and preserves saved or unreadable work', () => {
    const app = fixture();
    const ready = { scanComplete: true, installedAgentCount: 6, onStartTrial: () => {} };
    const empty = { goals: [], work: [], rules: [], focusAreas: [], requests: [] };
    const render = (reveal: RevealSets = empty, state = 'ok', options = ready) =>
      app.renderReveal([], reveal, { state, step: null }, [], null, false, options);
    expect(render()).toContain('6 agents are set up');
    expect(render(empty, 'ok', { ...ready, installedAgentCount: 1 })).toContain('1 agent is set up');
    expect(render()).toContain('Try Cloud Sync free for 30 days');
    expect(render()).toContain('$12/month after 30 days');
    expect(render()).not.toContain('No focus areas found');
    expect(render()).not.toContain('What else came through');
    expect(render({ ...empty, focusAreas: app.SAMPLE_FOCUS_AREAS })).toContain('Your recent work');
    expect(render({ ...empty, requestReadErrorCount: 1 })).toContain('Some requests could not be read');
    expect(render(empty, 'failed')).toContain('Couldn’t finish connecting your work');
    expect(render(empty, 'running')).toContain('Your recent work');
  });

  it('counts requests already linked to an area while other work is still connecting or unreadable', () => {
    const app = fixture();
    const agents = [{ id: 'codex', label: 'Codex', detected: true, prompts: 3, canRunSetup: null, cannotRunReason: null }];
    const running = { state: 'running', step: 'work' };
    const linked = app.renderReveal(agents, { goals: [], work: null, rules: null, focusAreas: app.SAMPLE_FOCUS_AREAS, requests: app.SAMPLE_REQUESTS, requestReadErrorCount: 1 }, running, ['codex']);
    expect(linked).toMatch(/>[1-9]\d* requests?</);
    expect(linked).toContain('Some work could not be read');
    const unlinked = app.renderReveal(agents, { goals: [], work: null, rules: null, focusAreas: app.SAMPLE_FOCUS_AREAS, requests: [], requestReadErrorCount: 0 }, running, ['codex']);
    expect(unlinked).toContain('Connecting work…');
    expect(unlinked).not.toContain('Some work could not be read');
  });

  it('lets people continue after capacity refusal without claiming results or a voluntary skip', () => {
    const app = fixture();
    const agents = [{ id: 'codex', label: 'Codex', detected: true, prompts: 3 }];
    const notice = 'Automatic organization is temporarily unavailable. You can continue setting up Claude-Mem.';
    for (const uploaded of [[], ['codex']]) {
      const html = app.renderReveal(agents, { goals: [], work: [], rules: [] }, { state: 'ok', step: null }, uploaded, notice);
      expect(html).toContain(notice);
      expect(html).toContain('Start with your next session');
      expect(html).not.toContain('already knows your work');
      expect(html).not.toContain('Your agents can build memory as you work.');
      expect(html).not.toContain('daily budget');
    }
  });

  it('does not credit saved results to messages when this upload was refused', () => {
    const app = fixture();
    const agents = [{ id: 'codex', label: 'Codex', detected: true, prompts: 3 }];
    const notice = 'Automatic organization is temporarily unavailable. You can continue setting up Claude-Mem.';
    const saved = { goals: null, work: null, rules: [{ id: 'saved', text: 'Test the change.', quote: 'an earlier quote', quotedAt: '2026-10-01T00:00:00.000Z' }] };
    const html = app.renderReveal(agents, saved, { state: 'ok', step: null }, ['codex'], notice);
    expect(html).toContain(notice);
    expect(html).toContain('an earlier quote');
    expect(html).not.toContain('From 3 messages');
  });

  it('credits the results only to the tools that were uploaded', () => {
    const app = fixture();
    const agents = [
      { id: 'codex', label: 'Codex', detected: true, prompts: 3, canRunSetup: null, cannotRunReason: null },
      { id: 'claude-code', label: 'Claude Code', detected: true, prompts: 7, canRunSetup: null, cannotRunReason: null },
    ];
    const html = app.renderReveal(agents, { goals: null, work: null, rules: null }, { state: 'running', step: 'goals' }, ['codex']);
    expect(html).toContain('3 messages from Codex');
    expect(html).not.toContain('Claude Code');
  });

  it('renders hosted failures and preference failures as alerts in plain words, with the raw words under Details', () => {
    const app = fixture();
    const html = app.renderScan(scan({ phase: 'failed', percent: 40, error: 'Hosted extraction exceeded the upload limit.' }), { kind: 'unreachable', detail: 'Failed to fetch' });
    expect(html.match(/role="alert"/g)).toHaveLength(2);
    expect(html).toContain('The scan stopped.');
    expect(html).toContain('<pre>Hosted extraction exceeded the upload limit.</pre>');
    expect(html).toContain('Couldn’t save this choice.');
    expect(html).toContain('Can’t reach claude-mem on this computer.');
    expect(html).toContain('<pre>Failed to fetch</pre>');
  });

  it('shows the server message from a failed anonymous upload on the scan screen', async () => {
    const app = fixture();
    useNetwork(url => url === '/api/setup/state'
      ? Response.json({ status: 'pending', alreadyPro: false })
      : Response.json(scan({ phase: 'uploading', percent: 99, uploadedAgents: ['codex'] })));
    let latest: any;
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    await until(() => latest.scan.phase === 'uploading');
    expect(latest.scan.uploadedAgents).toEqual(['codex']);
    const message = 'Hosted setup failed (HTTP 503): The anonymous daily budget has been reached.';
    Stream.latest.send('setup-scan', scan({ phase: 'failed', error: message }));
    const stopped = app.renderScan(latest.scan);
    expect(stopped).toContain('role="alert"');
    expect(stopped).toContain(`<pre>${message}</pre>`);
    stop();
  });

  it('offers an explicit retry after a failed extraction and keeps a retry refusal visible', () => {
    const app = fixture();
    const failed = scan({ phase: 'failed', done: true, error: 'The anonymous daily budget has been reached.' });
    const html = app.renderScan(failed);
    expect(html).toContain('Try again');
    expect(html).toContain('The anonymous daily budget has been reached.');
    expect(app.renderScan(scan({ phase: 'uploading' }))).not.toContain('Try again');
    const retrying = app.renderScan(failed, null, true);
    expect(retrying).toContain('aria-busy="true"');
    expect(retrying).toContain('Starting again…');
    const refused = app.renderScan(failed, null, false, { kind: 'refused', detail: 'The setup service is unavailable.' });
    expect(refused).toContain('Couldn’t start the scan again.');
    expect(refused).toContain('<pre>The setup service is unavailable.</pre>');
  });

  it('does not repeat a failed extraction until requested, then applies retry progress and results', async () => {
    const app = fixture();
    const posts: unknown[] = [];
    useNetwork((url, init) => {
      if (url === '/api/setup/state') return Response.json({ status: 'pending', alreadyPro: false });
      if (init.method) {
        posts.push(JSON.parse(String(init.body)));
        return Response.json(scan({ phase: 'reading', improveProduct: false }));
      }
      return Response.json(scan({ phase: 'failed', done: true, improveProduct: false, error: 'Please try again.' }));
    });
    let latest: any;
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    await until(() => latest.scan.phase === 'failed');
    await settle();
    expect(posts).toEqual([]);
    await app.localSetupSource.retryScan();
    expect(posts).toEqual([{}]);
    expect(latest.scan).toMatchObject({ phase: 'reading', done: false, error: null, improveProduct: false });
    Stream.latest.send('setup-scan', scan({ phase: 'done', done: true, percent: 100, improveProduct: false }));
    expect(latest.scan.phase).toBe('done');
    stop();
  });

  it('preserves newer streamed progress if it arrives before the retry response and returns server refusals', async () => {
    const app = fixture();
    let refused = false;
    useNetwork((url, init) => {
      if (url === '/api/setup/state') return Response.json({ status: 'pending', alreadyPro: false });
      if (!init.method) return Response.json(scan({ phase: 'failed', done: true, error: 'Please try again.' }));
      if (refused) return Response.json({ error: 'The setup service is unavailable.' }, { status: 503 });
      Stream.latest.send('setup-scan', scan({ phase: 'uploading', percent: 99 }));
      return Response.json(scan({ phase: 'reading' }));
    });
    let latest: any;
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    await until(() => latest.scan.phase === 'failed');
    await app.localSetupSource.retryScan();
    expect(latest.scan.phase).toBe('uploading');
    refused = true;
    Stream.latest.send('setup-scan', scan({ phase: 'failed', done: true, error: 'Please try again.' }));
    await expect(app.localSetupSource.retryScan()).rejects.toThrow('The setup service is unavailable.');
    stop();
  });

  it('buffers early unchecking without delaying the scan, sends false, and still receives upload/results', async () => {
    const app = fixture();
    const initial = deferred<Response>();
    const calls: Array<{ url: string; body: any }> = [];
    useNetwork((url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url === '/api/setup/state') return Response.json({ status: 'pending', alreadyPro: false });
      if (url === '/api/setup/scan' && !init.method) return initial.promise;
      if (url === '/api/setup/scan/preferences') return Response.json({ error: 'The setup upload has already started.' }, { status: 409 });
      if (url === '/api/setup/scan') {
        // A newer event can beat the older start response; it must keep upload locked.
        Stream.latest.send('setup-scan', scan({ phase: 'uploading', percent: 99, improveProduct: false }));
        return Response.json(scan({ phase: 'reading', improveProduct: false }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    let latest: any;
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    const changed = app.localSetupSource.setImproveProduct(false);
    await settle();
    expect(calls.some((call) => call.url.endsWith('/preferences'))).toBe(false);
    initial.resolve(Response.json(scan()));
    await changed;
    expect(calls.find((call) => call.url === '/api/setup/scan' && call.body)?.body).toEqual({ improveProduct: false });
    expect(calls.some((call) => call.url.endsWith('/preferences'))).toBe(false);
    expect(latest.scan.phase).toBe('uploading');
    expect(latest.scan.improveProduct).toBe(false);
    Stream.latest.send('work-view', {
      humanRequests: [], agents: [], source: { connected: true }, goals: null, rules: [], story: null,
      setup: { extraction: { state: 'ok', step: null }, work: [{ groupId: 'g1', title: 'Ship the upload', platform: 'codex', lastActiveAt: null, progressPercent: null }] },
    });
    Stream.latest.send('setup-scan', scan({ phase: 'done', done: true, percent: 100, improveProduct: false }));
    expect(latest.scan.done).toBe(true);
    expect(latest.reveal.work[0].title).toBe('Ship the upload');
    expect(latest.scan.phase).toBe('done');
    stop();
  });

  it('keeps the latest early toggle in the scan body and never sends an older queued choice', async () => {
    const app = fixture();
    const initial = deferred<Response>();
    const bodies: any[] = [];
    useNetwork((url, init) => {
      if (url === '/api/setup/state') return Response.json({ status: 'pending', alreadyPro: false });
      if (!init.method) return initial.promise;
      bodies.push(JSON.parse(String(init.body)));
      return Response.json(scan({ phase: 'reading', improveProduct: true }));
    });
    const stop = app.localSetupSource.subscribe(() => {});
    const first = app.localSetupSource.setImproveProduct(false);
    const last = app.localSetupSource.setImproveProduct(true);
    await settle();
    expect(bodies).toEqual([]);
    initial.resolve(Response.json(scan()));
    await Promise.all([first, last]);
    expect(bodies).toEqual([{ improveProduct: true }]);
    stop();
  });

  it('sends an unchecked preference for an active scan without waiting for it before upload/results', async () => {
    const app = fixture();
    const preference = deferred<Response>();
    const bodies: any[] = [];
    useNetwork((url, init) => {
      if (url === '/api/setup/state') return Response.json({ status: 'pending', alreadyPro: false });
      if (url.endsWith('/preferences')) {
        bodies.push(JSON.parse(String(init.body)));
        return preference.promise;
      }
      return Response.json(scan({ phase: 'reading' }));
    });
    let latest: any;
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    await until(() => latest.scan.phase === 'reading');
    const changed = app.localSetupSource.setImproveProduct(false);
    await until(() => bodies.length > 0);
    expect(bodies).toEqual([{ improveProduct: false }]);
    Stream.latest.send('setup-scan', scan({ phase: 'uploading', percent: 99, improveProduct: false }));
    Stream.latest.send('work-view', { humanRequests: [], agents: [], source: { connected: true }, goals: null, rules: [], story: null, setup: { extraction: { state: 'ok', step: null }, work: [] } });
    Stream.latest.send('setup-scan', scan({ phase: 'done', percent: 100, done: true, improveProduct: false }));
    expect(latest.scan.done).toBe(true);
    expect(latest.scan.improveProduct).toBe(false);
    expect(latest.extraction.state).toBe('ok');
    preference.resolve(Response.json(scan({ phase: 'reading', improveProduct: false })));
    await changed;
    expect(latest.scan.phase).toBe('done');
    stop();
  });

  it('ignores a stale initial GET after a newer scan event', async () => {
    const app = fixture();
    const initial = deferred<Response>();
    const posts: string[] = [];
    useNetwork((url, init) => {
      if (init.method) posts.push(url);
      if (url === '/api/setup/state') return Response.json({ status: 'pending', alreadyPro: false });
      return initial.promise;
    });
    let latest: any;
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    Stream.latest.send('setup-scan', scan({ phase: 'uploading', percent: 99, improveProduct: false }));
    initial.resolve(Response.json(scan()));
    await settle();
    expect(latest.scan.phase).toBe('uploading');
    expect(latest.scan.improveProduct).toBe(false);
    expect(posts).toEqual([]);
    stop();
  });

  it('does not start a scan after unsubscribe or overwrite streamed progress with a late request failure', async () => {
    for (const unsubscribe of [true, false]) {
      const app = fixture();
      const initial = deferred<Response>();
      const posts: string[] = [];
      useNetwork((url, init) => {
        if (init.method) posts.push(url);
        if (url === '/api/setup/state') return Response.json({ status: 'pending', alreadyPro: false });
        return initial.promise;
      });
      let latest: any;
      const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
      if (unsubscribe) { stop(); initial.resolve(Response.json(scan())); }
      else {
        Stream.latest.send('setup-scan', scan({ phase: 'uploading', percent: 99 }));
        initial.reject(new Error('Old GET failed'));
      }
      await settle();
      expect(posts).toEqual([]);
      expect(latest.scan.phase).toBe(unsubscribe ? 'idle' : 'uploading');
      stop();
    }
  });

  it('reports a failed preference save while leaving scan and results free to complete', async () => {
    const app = fixture();
    useNetwork((url) => {
      if (url === '/api/setup/state') return Response.json({ status: 'pending', alreadyPro: false });
      if (url.endsWith('/preferences')) return Response.json({ error: 'The setup upload has already started.' }, { status: 409 });
      return Response.json(scan({ phase: 'reading' }));
    });
    let latest: any;
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    await until(() => latest.scan.phase === 'reading');
    await expect(app.localSetupSource.setImproveProduct(false)).rejects.toThrow('The setup upload has already started.');
    expect(latest.scan.phase).toBe('reading');
    expect(latest.scan.error).toBe(null);
    Stream.latest.send('setup-scan', scan({ phase: 'done', done: true, percent: 100 }));
    expect(latest.scan.done).toBe(true);
    stop();
  });
});
 

describe('setup failures in plain words', () => {
  const failureOf = async (app: any, attempt: () => Promise<unknown>) => {
    try { await attempt(); } catch (error) { return app.toSetupFailure(error); }
    throw new Error('Expected the request to fail');
  };

  it('tells a request that got no answer from one the worker refused, and never credits the worker with a page error', async () => {
    const app = fixture();
    useNetwork(() => { throw new TypeError('Failed to fetch'); });
    expect(await failureOf(app, () => app.localSetupSource.choose({ branch: 'go', memoryBilling: 'hosted' }))).toEqual({ kind: 'unreachable', detail: 'Failed to fetch' });
    useNetwork(() => Response.json({ error: 'The installer already applied the earlier choice.' }, { status: 409 }));
    expect(await failureOf(app, () => app.localSetupSource.choose({ branch: 'home', memoryBilling: 'existing' }))).toEqual({ kind: 'refused', detail: 'The installer already applied the earlier choice.' });
    // A refusal without a JSON reason still names the status, under Details.
    useNetwork(() => new Response('Bad gateway', { status: 502 }));
    expect(await failureOf(app, () => app.localSetupSource.checkout())).toEqual({ kind: 'refused', detail: 'The worker answered 502 for /api/setup/checkout.' });
    // An answer without a saved note is a refusal too.
    useNetwork(() => Response.json({ success: false, reason: 'Text is empty.' }));
    expect((await failureOf(app, () => app.localSetupSource.keepNote({ id: 'm1', title: 'T', body: 'B', project: 'p', agent: 'a', session: 's', date: '2026-10-21' }, 'text'))).kind).toBe('refused');
    // Nothing went out: a retry with no connection to the worker, or any other error of the page's own.
    const notConnected = await failureOf(app, () => app.localSetupSource.retryScan());
    expect(notConnected.kind).toBe('page');
    expect(notConnected.detail).toContain('not connected');
    expect(app.toSetupFailure(new Error('Cannot read properties of undefined'))).toEqual({ kind: 'page', detail: 'Cannot read properties of undefined' });
    expect(app.toSetupFailure(new app.SetupRequestError('unreachable', 'Load failed')).kind).toBe('unreachable');
  });

  it('marks a first load that never reached the worker as unreachable, in the stopped scan and the connection, and claims no installation', async () => {
    const app = fixture();
    useNetwork(() => { throw new TypeError('Failed to fetch'); });
    let latest: any;
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    await until(() => latest?.scan.phase === 'failed');
    expect(latest.connectionError).toBe('Failed to fetch');
    expect(latest.connectionErrorKind).toBe('unreachable');
    expect(latest.scan.error).toBe('Failed to fetch');
    expect(latest.scan.errorKind).toBe('unreachable');
    // The worker never said whether anything was installed (the step bar must not tick Tools on a guess).
    expect(latest.install).toBeUndefined();
    stop();
  });

  for (const [label, answer, kind] of [
    ['gets no answer', () => { throw new TypeError('Failed to fetch'); }, 'unreachable'],
    ['is refused', () => Response.json({ error: 'The prompt scan is unavailable.' }, { status: 503 }), 'refused'],
  ] as const) {
    it(`marks the scan stopped as ${kind} when the page's own start ${label}, without a connection failure`, async () => {
      const app = fixture();
      useNetwork((url, init) => {
        if (url === '/api/setup/state') return Response.json({ status: 'pending', alreadyPro: false, install: null });
        if (url === '/api/setup/scan' && init.method === 'POST') return answer();
        return Response.json(scan());
      });
      let latest: any;
      const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
      await until(() => latest?.scan.phase === 'failed');
      expect(latest.scan.errorKind).toBe(kind);
      expect(latest.connectionError).toBeNull();
      expect(latest.connectionErrorKind).toBeNull();
      stop();
    });
  }

  it('shows the connection failure above the screen once: not again while the stopped scan says it', () => {
    const app = fixture();
    const failedScan = (error: string) => ({ ...app.EMPTY_SETUP_DATA.scan, phase: 'failed', error, errorKind: 'unreachable' });
    const data = (changes: object) => ({ ...app.EMPTY_SETUP_DATA, ...changes });
    expect(app.connectionFailureAbove(data({}), 'scan')).toBeNull();
    const firstLoad = data({ connectionError: 'Failed to fetch', connectionErrorKind: 'unreachable', scan: failedScan('Failed to fetch') });
    expect(app.connectionFailureAbove(firstLoad, 'scan')).toBeNull();
    // On any other screen, or once the scan stopped for its own reason, the page says it above the screen.
    expect(app.connectionFailureAbove(firstLoad, 'reveal')).toEqual({ kind: 'unreachable', detail: 'Failed to fetch' });
    const resumeRefused = data({ connectionError: 'Could not start setup.', connectionErrorKind: 'refused', scan: failedScan('The anonymous daily budget has been reached.') });
    expect(app.connectionFailureAbove(resumeRefused, 'scan')).toEqual({ kind: 'refused', detail: 'Could not start setup.' });
    const running = data({ connectionError: 'Could not start setup.', connectionErrorKind: 'refused', scan: { ...app.EMPTY_SETUP_DATA.scan, phase: 'reading' } });
    expect(app.connectionFailureAbove(running, 'scan')).toEqual({ kind: 'refused', detail: 'Could not start setup.' });
  });

  it('reports "<sent> of <total>" only when the worker sends both as real counts', async () => {
    const app = fixture();
    useNetwork((url) => url === '/api/setup/state' ? Response.json({ status: 'pending', alreadyPro: false }) : Response.json(scan({ phase: 'done', done: true })));
    let latest: any;
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    const run = { state: 'running', percent: 40, imported: 12, error: null };
    const progress = (frame: object) => { Stream.latest.send('setup-import', { ...run, ...frame }); return latest.historyImport; };
    expect(progress({ sent: 51, total: 128 })).toMatchObject({ percent: 40, sent: 51, total: 128 });
    // An older worker sends neither; a total of 0, a negative or a fractional count is no count at all.
    for (const frame of [{}, { sent: 0, total: 0 }, { sent: -1, total: 10 }, { sent: 1.5, total: 10 }, { sent: 5, total: '10' }, { sent: 5 }]) {
      const shown = progress(frame);
      expect(shown, JSON.stringify(frame)).not.toHaveProperty('sent');
      expect(shown, JSON.stringify(frame)).not.toHaveProperty('total');
    }
    expect(progress({ state: 'idle' })).toBeNull();
    expect(progress({ state: 'failed', error: 'cmem.ai refused the import (HTTP 503).', sent: 51, total: 128 })).toMatchObject({ error: 'cmem.ai refused the import (HTTP 503).', sent: 51, total: 128 });
    // The skipped count (what Finish Setup's receipt says the other memories were) is kept when it is a real count.
    expect(progress({ state: 'done', percent: 100, imported: 28, skipped: 100, sent: 128, total: 128 })).toMatchObject({ imported: 28, skipped: 100, sent: 128 });
    expect(progress({ state: 'done', percent: 100, imported: 0, skipped: 0, sent: 128, total: 128 })).toMatchObject({ skipped: 0 });
    for (const skipped of [undefined, -1, 1.5, '100']) expect(progress({ state: 'done', skipped }), String(skipped)).not.toHaveProperty('skipped');
    stop();
  });

  it('keeps a start\'s answer when a setup-state frame built before the start lands while the start is on its way', async () => {
    const app = fixture();
    const posts: string[] = [];
    let answerStart!: (response: Response) => void;
    const stopped = { state: 'stopped', percent: 78, imported: 100, error: null, sent: 100, total: 128, skipped: 0, unconfirmed: 28 };
    const setupState = { status: 'pending', alreadyPro: true, history: { projects: 3, sessions: 24, observations: 128 }, historyImport: stopped };
    useNetwork((url, init) => {
      if (init.method === 'POST') { posts.push(url); return new Promise<Response>((resolve) => { answerStart = resolve; }); }
      return url === '/api/setup/state' ? Response.json(setupState) : Response.json(scan({ phase: 'done', done: true }));
    });
    let latest: any;
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    await until(() => latest.historyImport?.state === 'stopped');
    // The person's Continue is on its way.
    const starting = app.localSetupSource.startHistoryImport();
    await until(() => posts.length === 1);
    expect(posts).toEqual(['/api/setup/import']);
    // A setup-state frame the worker built before it took the start (another setup write): it still has the stopped run.
    Stream.latest.send('setup-state', setupState);
    // The start's answer, the new run, comes before the event stream's first frame about it.
    answerStart(Response.json({ state: 'running', percent: 0, imported: 0, error: null, sent: 0, total: 128, skipped: 0, unconfirmed: 0 }, { status: 202 }));
    await starting;
    // The page knows the upload runs, so its import screen stays up instead of going back to Finish Setup.
    expect(latest.historyImport).toMatchObject({ state: 'running', sent: 0, total: 128 });
    stop();
  });

  it('starts nothing again after a Stop when the event stream reconnects or the worker restarts', async () => {
    const app = fixture();
    const posts: Array<{ url: string; body: unknown }> = [];
    const run = { state: 'running', percent: 78, imported: 100, error: null, sent: 100, total: 128, skipped: 0, unconfirmed: 0 };
    const stopped = { ...run, state: 'stopped', unconfirmed: 28 };
    const setupState = (historyImport: object) => ({ status: 'pending', alreadyPro: true, history: { projects: 3, sessions: 24, observations: 128 }, historyImport });
    useNetwork((url, init) => {
      if (init.method === 'POST') { posts.push({ url, body: JSON.parse(String(init.body)) }); return Response.json(stopped); }
      return url === '/api/setup/state' ? Response.json(setupState(run)) : Response.json(scan({ phase: 'done', done: true }));
    });
    let latest: any;
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    await until(() => latest.historyImport?.state === 'running');
    await app.localSetupSource.stopHistoryImport();
    expect(latest.historyImport).toMatchObject({ state: 'stopped', unconfirmed: 28 });
    // A reconnect: a new connection's first words are where setup stands (WorkViewRoutes.ts `events`), the stopped run.
    Stream.latest.send('setup-scan', scan({ phase: 'done', done: true }));
    Stream.latest.send('setup-state', setupState(stopped));
    expect(latest.historyImport).toMatchObject({ state: 'stopped' });
    // A restarted worker has no run at all.
    Stream.latest.send('setup-state', setupState({ state: 'idle', percent: 0, imported: 0, error: null, sent: 0, total: 0, skipped: 0, unconfirmed: 0 }));
    expect(latest.historyImport).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The one request the page sent is the person's Stop.
    expect(posts).toEqual([{ url: '/api/setup/import/stop', body: {} }]);
    stop();
  });

  it('stops the upload with its own request and shows the stopped run at once, never an older word over a newer one', async () => {
    const app = fixture();
    const posts: Array<{ url: string; body: unknown }> = [];
    const answers: Record<string, ReturnType<typeof deferred<Response>>> = {};
    useNetwork((url, init) => {
      if (init.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        answers[url] = deferred<Response>();
        return answers[url].promise;
      }
      return url === '/api/setup/state' ? Response.json({ status: 'pending', alreadyPro: false }) : Response.json(scan({ phase: 'done', done: true }));
    });
    let latest: any;
    const stop = app.localSetupSource.subscribe((data: any) => { latest = data; });
    // The page's first load is in (a person presses Stop long after it).
    await until(() => latest.scan.phase === 'done');
    const run = { state: 'running', percent: 40, imported: 51, error: null, sent: 51, total: 128, unconfirmed: 0 };
    Stream.latest.send('setup-import', run);
    expect(latest.historyImport).toMatchObject({ state: 'running', sent: 51 });
    expect(latest.historyImport).not.toHaveProperty('unconfirmed');

    // The stop's answer arrives before the event stream says anything: the page shows it from the answer.
    const stopping = app.localSetupSource.stopHistoryImport();
    await until(() => posts.length === 1);
    expect(posts).toEqual([{ url: '/api/setup/import/stop', body: {} }]);
    answers['/api/setup/import/stop'].resolve(Response.json({ ...run, state: 'stopped', unconfirmed: 77 }));
    await stopping;
    expect(latest.historyImport).toEqual({ state: 'stopped', percent: 40, imported: 51, error: null, sent: 51, total: 128, unconfirmed: 77 });

    // An answer that comes after a newer frame is older than that frame: the frame stays.
    const starting = app.localSetupSource.startHistoryImport();
    await until(() => posts.length === 2);
    Stream.latest.send('setup-import', { ...run, sent: 0, percent: 0, imported: 0 });
    answers['/api/setup/import'].resolve(Response.json({ ...run, state: 'stopped', unconfirmed: 77 }));
    await starting;
    expect(posts[1]).toEqual({ url: '/api/setup/import', body: {} });
    expect(latest.historyImport).toMatchObject({ state: 'running', sent: 0 });

    // A refused stop throws for the page to show, and changes nothing.
    const refused = app.localSetupSource.stopHistoryImport();
    await until(() => posts.length === 3);
    answers['/api/setup/import/stop'].resolve(Response.json({ error: 'No import is running, so there is nothing to stop.' }, { status: 409 }));
    expect(await refused.then(() => null, (error: unknown) => app.toSetupFailure(error))).toEqual({ kind: 'refused', detail: 'No import is running, so there is nothing to stop.' });
    expect(latest.historyImport).toMatchObject({ state: 'running', sent: 0 });

    // A state this page has no words for (a newer worker's) is not shown as anything, so it is never called running.
    Stream.latest.send('setup-import', { ...run, state: 'paused' });
    expect(latest.historyImport).toBeNull();
    stop();
  });

  it('says the scan was skipped only when the person skipped it and nothing came back', () => {
    const app = fixture();
    const agents = [{ id: 'codex', label: 'Codex', detected: true, prompts: 3, canRunSetup: null, cannotRunReason: null }];
    const nothing = { goals: null, work: null, rules: null, focusAreas: null, requests: [] };
    const skipped = app.renderReveal(agents, nothing, null, null, null, true);
    expect(skipped).toContain('Your agents can build memory as you work.');
    expect(skipped).toContain('Start with your next session');
    // Results from an earlier run still show after a skip, and the page does not call them skipped.
    const earlier = app.renderReveal(agents, { ...nothing, focusAreas: app.SAMPLE_FOCUS_AREAS, requests: app.SAMPLE_REQUESTS }, null, null, null, true);
    expect(earlier).not.toContain('Your agents can build memory as you work.');
    expect(earlier).toContain('Your focus areas');
    expect(app.renderReveal(agents, nothing, { state: 'running', step: 'goals' }, ['codex'])).not.toContain('Your agents can build memory as you work.');
  });
});
