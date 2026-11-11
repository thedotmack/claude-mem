import { afterEach, describe, expect, it } from 'bun:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Compile the real component and source together: no DOM package or paid service is needed.
const compiled = buildSync({
  stdin: {
    resolveDir: resolve(import.meta.dir, '../../../src/ui/my-work'), loader: 'tsx', contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { ScanScreen } from './src/setup/screens/scan-screen';
      import { RevealScreen } from './src/setup/screens/reveal-screen';
      import { InstallScreen } from './src/setup/screens/install-screen';
      export const renderReveal = (agents, reveal, extraction, uploadedAgents = null, hostedNotice = null) => renderToStaticMarkup(<RevealScreen agents={agents} reveal={reveal} extraction={extraction} uploadedAgents={uploadedAgents} recentPrompts={[]} hostedNotice={hostedNotice} onContinue={() => {}} />);
      export { localSetupSource, EMPTY_SETUP_DATA, setupPending, setupToolsForInstall } from './src/setup/setup-data';
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
    expect(html).toContain('Where do you work?');
    expect(html).toContain('Cursor');
    expect(html).toContain('Codex CLI');
    expect(html).toContain('Skills and preferences');
    expect(html).toContain('Claude model');
    expect(html).toContain('Install and continue');
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
    expect(latest.choice).toEqual(home);
    expect(latest.scan.phase).toBe('idle');
    expect(latest.scan.error).toBeNull();
    failResume = false;
    await app.localSetupSource.resume();
    expect(latest.connectionError).toBeNull();
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
    expect(initial).not.toContain('Discover My Work, Rules &amp; Focus');
    const consent = app.renderScan(scan({ phase: 'awaiting-consent' }));
    expect(consent).toContain('Discover My Work, Rules &amp; Focus');
    expect(consent).toContain('Skip this step');
    const undetected = app.renderScan(scan({ phase: 'awaiting-consent', agents: [{ id: 'claude-code', label: 'Claude Code', detected: false, prompts: 2, canRunSetup: null, cannotRunReason: null }] }));
    expect(undetected).toContain('Claude Code (2 messages)');
    expect(undetected).not.toMatch(/<button[^>]*disabled[^>]*>Discover My Work, Rules &amp; Focus/);
    const sending = app.renderScan(scan({ phase: 'awaiting-consent', agents: [{ id: 'codex', label: 'Codex', detected: true, prompts: 3, canRunSetup: null, cannotRunReason: null }] }), null, false, null, null, true);
    expect(sending).toContain('Sending your choice');
    expect(sending).toMatch(/<button[^>]*disabled[^>]*>Discover My Work, Rules &amp; Focus/);
    expect(app.renderScan(scan({ phase: 'awaiting-consent' }), null, false, null, 'Could not send your choice')).toContain('class="scan-error" role="alert">Could not send your choice');
    expect(app.renderScan(scan({ phase: 'awaiting-consent', agents: [{ id: 'codex', label: 'Codex', detected: true, prompts: 3, canRunSetup: null, cannotRunReason: null }] }))).toContain('Codex (3 messages)');
    const visibleConsent = consent.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
    expect(visibleConsent).toContain('Claude-Mem scans your transcripts to automatically discover your existing work, your preferences, and what you’re focused on.');
    expect(visibleConsent).toContain('Selected messages are sent to cmem.ai and an AI provider.');
    expect(visibleConsent).not.toContain('session IDs');
    expect(visibleConsent).not.toContain('timestamps');
    expect(consent).toContain('What gets uploaded?');
    expect(consent).toContain('The full text of your messages from the last 30 days in the selected tools');
    expect(consent).toContain('session IDs, project names, folder paths and timestamps');
    expect(app.renderScan(scan({ phase: 'saving' }))).not.toContain('disabled=""');
    expect(app.renderScan(scan({ phase: 'uploading' }))).toContain('disabled=""');
  });

  it('leads with discovering existing work and keeps skip available underneath', () => {
    const app = fixture();
    const html = app.renderScan(scan({ phase: 'awaiting-consent', agents: [{ id: 'codex', label: 'Codex', detected: true, prompts: 3, canRunSetup: null, cannotRunReason: null }] }));
    const buttons = [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>(Skip this step|Discover My Work, Rules &amp; Focus)</g)];
    expect(buttons.map(match => match[2])).toEqual(['Discover My Work, Rules &amp; Focus', 'Skip this step']);
    expect(buttons.map(match => match[1])).toEqual(['primary', 'scan-consent-skip']);
  });

  it('shows the skipped-step message only when the person actually skipped', () => {
    const app = fixture();
    const agents = [{ id: 'codex', label: 'Codex', detected: true, prompts: 3, canRunSetup: null, cannotRunReason: null }];
    const empty = { goals: [], work: [], rules: [] };
    const local = app.renderReveal(agents, empty, { state: 'ok', step: null }, []);
    expect(local).toContain('You skipped this step.');
    expect(local).not.toContain('Your work is starting to connect.');
    // An upload that came back with nothing must never be described as "nothing was uploaded".
    const uploadedEmpty = app.renderReveal(agents, empty, { state: 'ok', step: null }, ['codex']);
    expect(uploadedEmpty).not.toContain('You skipped this step.');
    expect(uploadedEmpty).not.toContain('Nothing was uploaded');
    expect(app.renderReveal(agents, { goals: null, work: null, rules: null }, { state: 'running', step: 'goals' }, ['codex'])).toContain('Your work is starting to connect.');
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
      expect(html).toContain('Continue setup.');
      expect(html).not.toContain('already knows your work');
      expect(html).not.toContain('You skipped this step.');
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
    expect(html).toContain('From 3 messages across Codex');
    expect(html).not.toContain('Claude Code');
  });

  it('renders hosted failures and preference failures in the existing alert style', () => {
    const app = fixture();
    const html = app.renderScan(scan({ phase: 'failed', error: 'Hosted extraction exceeded the upload limit.' }), 'Could not save this choice: Network unavailable.');
    expect(html).toContain('class="scan-error" role="alert">Hosted extraction exceeded the upload limit.');
    expect(html).toContain('class="scan-error" role="alert">Could not save this choice: Network unavailable.');
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
    expect(app.renderScan(latest.scan)).toContain(`class="scan-error" role="alert">${message}`);
    stop();
  });

  it('offers an explicit retry after a failed extraction and keeps a retry refusal visible', () => {
    const app = fixture();
    const failed = scan({ phase: 'failed', done: true, error: 'The anonymous daily budget has been reached.' });
    const html = app.renderScan(failed);
    expect(html).toContain('Try again');
    expect(html).toContain('The anonymous daily budget has been reached.');
    expect(app.renderScan(scan({ phase: 'uploading' }))).not.toContain('Try again');
    expect(app.renderScan(failed, null, true)).toContain('disabled=""');
    expect(app.renderScan(failed, null, false, 'The setup service is unavailable.')).toContain('role="alert">The setup service is unavailable.');
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
 
