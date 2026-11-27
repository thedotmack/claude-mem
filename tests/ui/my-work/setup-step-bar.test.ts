import { describe, expect, it } from 'bun:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Plan Phase 8: the five-step bar, the bottom row's Back and the screens' own buttons and marks, rendered from the real
// components (no DOM needed). Lists of steps, screens and states come from their one definition (state-machines.md).
const compiled = buildSync({
  stdin: {
    resolveDir: resolve(import.meta.dir, '../../../src/ui/my-work'), loader: 'tsx', contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { SetupStepBar } from './src/setup/screens/step-bar';
      import { InstallScreen } from './src/setup/screens/install-screen';
      import { ScanScreen } from './src/setup/screens/scan-screen';
      import { RevealScreen } from './src/setup/screens/reveal-screen';
      import { ChoiceScreen } from './src/setup/screens/choice-screen';
      import { CheckoutScreen } from './src/setup/screens/checkout-screen';
      import { FinishSetupScreen } from './src/setup/screens/finish-setup-screen';
      import { ImportScreen } from './src/setup/screens/import-screen';
      import { LaunchScreen } from './src/setup/screens/launch-screen';
      import { WorkspaceScreen } from './src/setup/screens/workspace-screen';
      import { ToolMark } from './src/setup/screens/shared';
      import { SAMPLE_REQUESTS } from './src/data';
      import { SAMPLE_FOCUS_AREAS } from './src/data-goals';
      export { initialFlowState, SETUP_STEPS, ROUTED_SETUP_STEPS, SETUP_PROGRESS_STEPS, SETUP_PROGRESS_STATES, PROGRESS_STEP_WORDS, PROGRESS_STEP_OF_SCREEN, SCAN_PHASE_RUNNING } from './src/setup/setup-flow';
      export { SAMPLE_REQUESTS, SAMPLE_FOCUS_AREAS };
      export { HISTORY_IMPORT_RUN_STATES } from '../../shared/setup-funnel';
      export const renderImport = (progress, stopping = false) => renderToStaticMarkup(<ImportScreen progress={progress} back={{ onBack: noop, waitsFor: 'import' }} stopping={stopping} onStop={noop} />);
      const history = { projects: 3, sessions: 24, observations: 128 };
      export const renderHistoryPanel = (importResult, importStatus = 'available', stoppingImport = false) => renderToStaticMarkup(<FinishSetupScreen branch="go" tools={[]} selected={[]} onSelect={noop} history={history} importStatus={importStatus} importResult={importResult} stoppingImport={stoppingImport} onImport={noop} onStopImport={noop} back={null} onContinue={noop} />);
      export const renderBar = (step, flow) => renderToStaticMarkup(<SetupStepBar step={step} flow={flow} />);
      export const renderMark = (id, name) => renderToStaticMarkup(<ToolMark id={id} name={name} />);
      const noop = () => {};
      const scan = (phase) => ({ agents: [], percent: 40, phase, done: phase === 'done', error: phase === 'failed' ? 'Failed to fetch' : null, improveProduct: true, uploadedAgents: null });
      export const renderScan = (phase, { retrying = false, back = null } = {}) => renderToStaticMarkup(<ScanScreen scan={scan(phase)} back={back} onImproveProductChange={noop} onConfirmUpload={noop} preferenceError={null} onRetry={noop} retrying={retrying} retryError={null} onSkip={noop} onContinue={noop} />);
      export const renderCheckout = (checkout, asked, offer = {}) => renderToStaticMarkup(<CheckoutScreen checkout={checkout} asked={asked} installerStopped={false} back={{ onBack: noop, waitsFor: null }} onOpen={noop} onContinue={noop} {...offer} />);
      export const renderExistingCloudPlan = () => renderToStaticMarkup(<ChoiceScreen branch="go" alreadyPro onChoose={noop} />);
      export const renderReveal = (reveal) => renderToStaticMarkup(<RevealScreen agents={[]} reveal={reveal} extraction={{ state: 'ok', step: null }} uploadedAgents={['codex']} recentPrompts={[]} onContinue={noop} />);
      const install = { status: 'ready', error: null, selection: { agents: ['cursor'], skills: [], installClaudeCode: false, disableAutoMemory: false, telemetryEnabled: true },
        catalog: { agents: [{ id: 'cursor', label: 'Cursor', hint: '', detected: true }], skills: [], reinstall: false,
          defaults: { agents: ['cursor'], skills: [], installClaudeCode: false, disableAutoMemory: false, telemetryEnabled: true } } };
      const tool = { id: 'chatgpt', name: 'ChatGPT', kind: 'cloud' };
      export const renderScreens = (back, scanPhase = 'reading') => ({
        install: renderToStaticMarkup(<InstallScreen install={install} onInstall={async () => {}} onContinue={noop} />),
        scan: renderToStaticMarkup(<ScanScreen scan={scan(scanPhase)} back={back} onImproveProductChange={noop} onConfirmUpload={noop} preferenceError={null} onRetry={noop} retrying={false} retryError={null} onSkip={noop} onContinue={noop} />),
        reveal: renderToStaticMarkup(<RevealScreen agents={[]} reveal={{ goals: [], work: [], rules: [], focusAreas: SAMPLE_FOCUS_AREAS, requests: SAMPLE_REQUESTS }} extraction={{ state: 'ok', step: null }} uploadedAgents={['codex']} recentPrompts={[]} back={back} onContinue={noop} />),
        choice: renderToStaticMarkup(<ChoiceScreen branch="go" back={back} onChoose={noop} />),
        checkout: renderToStaticMarkup(<CheckoutScreen checkout={null} asked={false} installerStopped={false} back={back} onOpen={noop} onContinue={noop} />),
        'finish-setup': renderToStaticMarkup(<FinishSetupScreen branch="go" tools={[tool]} selected={['chatgpt']} onSelect={noop} history={null} importStatus="none" importResult={null} stoppingImport={false} onImport={noop} onStopImport={noop} back={back} onContinue={noop} />),
        import: renderToStaticMarkup(<ImportScreen progress={{ state: 'running', percent: 48, imported: 61, error: null, sent: 61, total: 128 }} back={back} stopping={false} onStop={noop} />),
        launch: renderToStaticMarkup(<LaunchScreen tools={[tool]} back={back} onDone={noop} />),
        workspace: renderToStaticMarkup(<WorkspaceScreen suggestions={[]} back={back} search={async () => []} keepNote={async () => 1} forgetNote={async () => {}} onContinue={noop} />),
      });
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

const app = fixture();
/** The bar's names, in its order, from the one definition. */
const NAMES: string[] = app.SETUP_PROGRESS_STEPS.map((step: string) => app.PROGRESS_STEP_WORDS[step]);
const STATES = new RegExp(`<li data-state="(${app.SETUP_PROGRESS_STATES.join('|')})"[^>]*>([\\s\\S]*?)<\\/li>`, 'g');
const items = (html: string) => [...html.matchAll(STATES)].map(([, state, body]) => ({ state, body }));
/** Every scan phase, from the one Record that says which of them run. */
const SCAN_PHASES = Object.keys(app.SCAN_PHASE_RUNNING);
/** Every screen's own buttons in the screen's navy look (`primary` anywhere in the class list). */
const navyButtons = (html: string) => html.match(/<button[^>]*class="[^"]*\bprimary\b[^"]*"[^>]*>/g) ?? [];

describe('setup step bar', () => {
  it('lists every step on each screen, with the screen\'s own step current', () => {
    for (const step of app.ROUTED_SETUP_STEPS) {
      const html = app.renderBar(step, app.initialFlowState(false));
      expect(html).toContain('aria-label="Setup progress"');
      const bar = items(html);
      expect(bar.map(item => item.body.match(/class="step-name">([^<]+)</)?.[1])).toEqual(NAMES);
      expect(html.match(/aria-current="step"/g)).toHaveLength(1);
      expect(bar.find(item => item.state === 'current')?.body).toContain(`>${app.PROGRESS_STEP_WORDS[app.PROGRESS_STEP_OF_SCREEN[step]]}<`);
    }
  });

  it('ticks a step only after the person has done it, and says so in words', () => {
    const start = app.initialFlowState(false);
    const installing = items(app.renderBar('install', { ...start, installationComplete: false }));
    expect(installing.map(item => item.state)).toEqual(['current', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
    expect(installing.some(item => item.body.includes('lucide-check'))).toBe(false);
    const planning = items(app.renderBar('checkout', { ...start, scanComplete: true, revealContinued: true, choiceContinued: true }));
    expect(planning.map(item => item.state)).toEqual(['done', 'done', 'current', 'upcoming', 'upcoming']);
    for (const item of planning) {
      expect(item.body.includes('lucide-check')).toBe(item.state === 'done');
      expect(item.body.includes('<span class="sr-only"> (completed)</span>')).toBe(item.state === 'done');
    }
  });
});

describe('setup bottom row Back', () => {
  const back = { onBack: () => {}, waitsFor: null };
  const backButton = (html: string) => html.match(/<button[^>]*setup-back[^>]*>[\s\S]*?<\/button>/)?.[0] ?? null;

  it('is on every screen but the first, in one style, before the forward buttons', () => {
    const screens = app.renderScreens(back);
    const [first, ...rest] = app.ROUTED_SETUP_STEPS as string[];
    expect(backButton(screens[first])).toBeNull();
    for (const step of rest) {
      const html = screens[step];
      const button = backButton(html);
      expect(button, step).not.toBeNull();
      expect(button!, step).toContain('>Back</button>');
      expect(button!, step).toContain('text-action setup-back');
      expect(button!, step).not.toContain('aria-disabled="true"');
      // Back sits on the left of the row, so it comes before the row's forward buttons.
      expect(html.indexOf('setup-back'), step).toBeLessThan(html.indexOf('setup-actions-forward'));
    }
  });

  it('is left out where the page has no earlier screen to offer', () => {
    const screens = app.renderScreens(null);
    for (const step of Object.keys(screens)) expect(backButton(screens[step]), step).toBeNull();
  });

  it('waits, with its reason beside it, while the scan or the import runs', () => {
    const scanning = app.renderScreens({ ...back, waitsFor: 'scan' }).scan;
    const button = backButton(scanning)!;
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain('aria-describedby="setup-waiting-line"');
    expect(scanning).toContain('<p id="setup-waiting-line" class="setup-waiting">Back waits while the scan runs.</p>');
    const importing = app.renderScreens({ ...back, waitsFor: 'import' }).import;
    expect(backButton(importing)).toContain('aria-disabled="true"');
    expect(importing).toContain('<p id="setup-waiting-line" class="setup-waiting">Back waits while the import runs.</p>');
    // The import says how far it is when the worker reports it.
    expect(importing).toContain('61 of 128');
  });

  it('keeps one navy button per screen', () => {
    for (const phase of SCAN_PHASES) {
      for (const [step, html] of Object.entries(app.renderScreens(back, phase) as Record<string, string>)) {
        expect(navyButtons(html).length, `${step} (${phase})`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('setup scan bottom row', () => {
  it('offers nothing to press forward while the scan runs: the page moves on by itself when it finishes', () => {
    const running = app.renderScan('reading', { back: { onBack: () => {}, waitsFor: 'scan' } });
    expect(navyButtons(running)).toEqual([]);
    expect(running).not.toContain('Continue');
    // The done state, seen only on the way Back from the Reveal, has its Continue.
    expect(navyButtons(app.renderScan('done')).join('')).toContain('primary');
    expect(app.renderScan('done')).toContain('Continue');
  });

  it('keeps the sharing choice open while the scan can use it, and read-only once the scan is done', () => {
    // The done scan shows only on the way Back from the Reveal; a change there would send a request after the scan.
    const box = (html: string) => html.match(/<label class="scan-improve-product">[\s\S]*?<\/label>/)?.[0] ?? '';
    for (const phase of SCAN_PHASES) {
      const label = box(app.renderScan(phase));
      expect(label, phase).toContain('type="checkbox"');
      expect(label.includes('disabled=""'), phase).toBe(phase === 'uploading' || phase === 'done');
    }
    expect(box(app.renderScan('done'))).toContain('The scan is done, and this choice was saved with it.');
    expect(box(app.renderScan('reading'))).not.toContain('Shared with cmem.ai');
    expect(box(app.renderScan('organizing'))).not.toContain('Shared with cmem.ai');
    expect(box(app.renderScan('awaiting-consent'))).toContain('Shared with cmem.ai only when you include conversations.');
  });

  it('dims "Continue with new work" while "Try again" is starting the scan, and only then', () => {
    const skip = (html: string) => html.match(/<button[^>]*>Continue with new work<\/button>/)?.[0];
    const idle = skip(app.renderScan('failed'));
    const retrying = skip(app.renderScan('failed', { retrying: true }));
    expect(idle).toBeDefined();
    expect(retrying).toBeDefined();
    expect(idle).not.toContain('aria-disabled="true"');
    expect(retrying).toContain('aria-disabled="true"');
    expect(app.renderScan('failed', { retrying: true })).toContain('aria-busy="true"');
  });
});

describe('setup checkout', () => {
  it('has no screen for the old hosted offer: setup never shows it', () => {
    expect(app.SETUP_STEPS).toContain('savings');
    expect(app.ROUTED_SETUP_STEPS).not.toContain('savings');
    expect(Object.keys(app.renderScreens(null))).toEqual(app.ROUTED_SETUP_STEPS);
    for (const html of Object.values(app.renderScreens(null)) as string[]) expect(html).not.toContain('https://cmem.ai/hosted-tokens');
  });
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(([, body]) => body.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
  it('keeps an existing Cloud or Pro configuration without offering a new subscription', () => {
    const html = app.renderExistingCloudPlan();
    expect(html).toContain('Keep your existing plan');
    expect(html).not.toContain('Continue to Cloud Sync checkout');
    expect(html).not.toContain('name="cloud-sync-offer"');
    expect(html).not.toContain('$99');
    expect(html).not.toContain('$12');
  });
  it('discloses a full monthly Cloud trial while keeping hosted token billing separate', () => {
    const html = app.renderCheckout(null, false);
    expect(html).toContain('Cloud Sync');
    expect(html).toContain('Due today for your first trial</dt><dd>$0');
    expect(html).toContain('$12 / month');
    expect(html).toContain('If you continue after 30 days');
    expect(html).not.toContain('Secure checkout with Stripe');
    expect(html).toContain('No card needed for your first trial.');
    expect(html).not.toContain('href="https://cmem.ai/hosted-tokens"');
    expect(html).not.toContain('included usage runs out');
    expect(html).not.toContain('$30');
  });

  it('discloses the annual charge now and keeps saved bundled choices compatible', () => {
    const annual = app.renderCheckout(null, false, { cloudSyncOffer: 'cloud_sync_annual' });
    expect(annual).toContain('Due today</dt><dd>$99');
    expect(annual).toContain('$99 / year');
    expect(annual).toContain('No trial.');
    expect(annual).toContain('A card is required.');
    expect(annual).toContain('Secure checkout with Stripe');
    expect(annual).not.toContain('30 days');
    expect(annual).not.toContain('$12');
    const legacy = app.renderCheckout(null, false, { legacyHosted: true });
    expect(legacy).toContain('CMEM Pro · Cloud Sync included');
    expect(legacy).toContain('$30 / month');
    expect(legacy).toContain('A card is required.');
    expect(legacy).toContain('Billing starts on your renewal date unless you cancel.');
    expect(legacy).toContain('hosted generation pauses');
    expect(legacy).toContain('your configured backup provider');
    expect(legacy).not.toContain('automatically upgrades');
    expect(legacy).not.toContain('Overages are billed');
    expect(legacy).not.toContain('Your Cloud Sync trial lasts a full 30 days.');
  });
  it('shows a pending handoff and allows an explicit reopen once checkout is running', () => {
    const asked = app.renderCheckout(null, true);
    expect(asked).toContain('Opening Cloud Sync…');
    expect(asked).toContain('data-slot="spinner"');
    expect(buttons(asked)).toContain('Opening Cloud Sync…');
    expect(buttons(app.renderCheckout({ state: 'waiting', error: null }, false))).toContain('Reopen Cloud Sync setup');
    const fresh = app.renderCheckout(null, false);
    expect(fresh).not.toContain('Waiting for this device to connect…');
    expect(buttons(fresh)).toContain('Open Cloud Sync setup');
  });

  it('shows the device code cmem.ai asks for beside the wait, with a way to copy it, only while checkout waits', () => {
    const waiting = app.renderCheckout({ state: 'waiting', error: null, userCode: 'K7QM-4XPT' }, true);
    expect(waiting).toContain('Waiting for this device to connect…');
    expect(waiting).toContain('Your device code');
    // The code itself follows its label.
    expect(waiting.indexOf('Your device code')).toBeGreaterThan(-1);
    expect(waiting.indexOf('K7QM-4XPT')).toBeGreaterThan(waiting.indexOf('Your device code'));
    expect(waiting).toContain('cmem.ai asks for this code after you start your free trial.');
    // The copy button draws every state's words at once (StatefulButton); at rest it reads Copy code.
    const copy = waiting.match(/<button[^>]*data-save-state="[^"]*"[^>]*>/g) ?? [];
    expect(copy).toHaveLength(1);
    expect(buttons(waiting).some(text => text.startsWith('Copy code'))).toBe(true);
    // The code's copy button is not the screen's way on.
    expect(navyButtons(waiting)).not.toContain(copy[0]);
    expect(buttons(waiting)).toContain('Reopen Cloud Sync setup');
    // The annual plan has no trial: the line says when cmem.ai asks instead.
    const annual = app.renderCheckout({ state: 'waiting', error: null, userCode: 'K7QM-4XPT' }, true, { cloudSyncOffer: 'cloud_sync_annual' });
    expect(annual).toContain('K7QM-4XPT');
    expect(annual).toContain('cmem.ai asks for this code after checkout.');
    expect(annual).not.toContain('free trial.');
    // No code yet (an older installer, or a new pairing on its way), or no longer waiting: no code block at all.
    for (const checkout of [{ state: 'waiting', error: null }, { state: 'waiting', error: null, userCode: null },
      { state: 'requested', error: null, userCode: 'K7QM-4XPT' }, { state: 'paid', error: null, userCode: 'K7QM-4XPT' },
      { state: 'failed', error: 'Checkout did not finish.', userCode: 'K7QM-4XPT' }]) {
      const html = app.renderCheckout(checkout, true);
      expect(html).not.toContain('Your device code');
      expect(html).not.toContain('K7QM-4XPT');
    }
    // The installer stopped: nothing waits on that pairing, so its code is not offered.
    const stopped = app.renderCheckout({ state: 'waiting', error: null, userCode: 'K7QM-4XPT' }, true, { installerStopped: true });
    expect(stopped).not.toContain('Your device code');
    expect(stopped).not.toContain('K7QM-4XPT');
    // A code past its expiry no longer connects this device: the wait shows, the dead code does not.
    const expired = app.renderCheckout({ state: 'waiting', error: null, userCode: 'K7QM-4XPT', expiresAt: new Date(Date.now() - 1_000).toISOString() }, true);
    expect(expired).toContain('Waiting for this device to connect…');
    expect(expired).not.toContain('Your device code');
    expect(expired).not.toContain('K7QM-4XPT');
    const live = app.renderCheckout({ state: 'waiting', error: null, userCode: 'K7QM-4XPT', expiresAt: new Date(Date.now() + 600_000).toISOString() }, true);
    expect(live).toContain('K7QM-4XPT');
  });

  it('goes on from a paid checkout without asking for checkout again', () => {
    const paid = app.renderCheckout({ state: 'paid', error: null }, true);
    expect(paid).toContain('Cloud Sync connected.');
    // The one way on is Continue (the page wires it to Finish Setup); nothing on the screen opens checkout again.
    expect(buttons(paid)).not.toContain('Reopen Cloud Sync setup');
    expect(buttons(paid)).not.toContain('Open Cloud Sync setup');
    expect(buttons(paid)).toContain('Back');
    expect(navyButtons(paid)).toHaveLength(1);
    expect(paid.match(/<button[^>]*class="[^"]*\bprimary\b[^"]*"[^>]*>([\s\S]*?)<\/button>/)?.[1].replace(/<[^>]+>/g, '').trim()).toBe('Continue');
  });
});

describe('setup reveal rows', () => {
  const reveal = (requests = app.SAMPLE_REQUESTS) => app.renderReveal({ goals: [], work: [], rules: [], focusAreas: app.SAMPLE_FOCUS_AREAS, requests }) as string;

  it('keeps "Explore this focus" on each row as a quiet action, never a navy button', () => {
    const html = reveal();
    const rows = (html.match(/<li class="reveal-area">/g) ?? []).length;
    expect(rows).toBeGreaterThan(0);
    const explore = html.match(/<button[^>]*>Explore this focus[\s\S]*?<\/button>/g) ?? [];
    expect(explore).toHaveLength(rows);
    for (const button of explore) {
      expect(button).toContain('text-action');
      expect(button).not.toMatch(/class="[^"]*\bprimary\b/);
      // Its row's name is read with it, so each one says which area it opens.
      expect(button).toMatch(/aria-describedby="[^"]+"/);
    }
    expect(navyButtons(html)).toHaveLength(1);
  });

  it('makes "still being sorted" a link on the line with the others, closed until pressed', () => {
    // A request with no recorded area is still being sorted.
    const unsorted = { ...app.SAMPLE_REQUESTS[0], id: 'unsorted-request', focusAreaId: undefined, closed: false };
    const html = reveal([...app.SAMPLE_REQUESTS, unsorted]);
    const links = html.match(/<div class="reveal-links">[\s\S]*?<\/div>/)?.[0] ?? '';
    const sorting = links.match(/<button[^>]*reveal-sorting[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(sorting).toBeDefined();
    expect(sorting).toMatch(/\d+ still being sorted/);
    expect(sorting).toContain('text-action');
    expect(sorting).toContain('aria-expanded="false"');
    expect(html).not.toContain('reveal-sorting-list');
  });
});

describe('setup tool marks', () => {
  // Marks for the tools a setup screen can list together: the scan's readers, the installer's catalog and Finish
  // Setup's cloud readers (labels from src/services/prompt-import/readers.ts, src/npx-cli/commands/ide-detection.ts
  // and SETUP_TOOLS). A tool named two ways keeps one mark.
  const TOOLS: Array<[string, string]> = [
    ['claude-code', 'Claude Code'], ['claude-ai', 'Claude.ai'], ['codex', 'Codex'], ['codex-cli', 'Codex CLI'], ['chatgpt', 'ChatGPT'],
    ['gemini-cli', 'Gemini CLI'], ['antigravity-cli', 'Antigravity CLI'], ['antigravity', 'Antigravity'], ['opencode', 'OpenCode'],
    ['openclaw', 'OpenClaw'], ['windsurf', 'Windsurf'], ['t3code', 'T3 Code'], ['kimi', 'Kimi Code'], ['devin', 'Devin CLI / Desktop'],
    ['cursor', 'Cursor'], ['grok-bot', 'Grok Bot'], ['copilot-cli', 'Copilot CLI'], ['copilot-vscode', 'Copilot in VS Code'], ['omp', 'OMP'], ['hermes', 'Hermes Agent'], ['pi', 'Pi'],
    ['dsh', 'DeepSeek Harness'], ['goose', 'Goose'], ['roo-code', 'Roo Code'], ['warp', 'Warp'], ['zed', 'Zed'],
    ['zcode', 'ZCode'], ['mcode', 'MiniMax Code'],
  ];
  const SAME_TOOL = [['codex', 'codex-cli'], ['antigravity', 'antigravity-cli']];
  const mark = (id: string, name: string) => app.renderMark(id, name).replace(/data:[^"]+/, (uri: string) => `image:${uri.length}:${uri.slice(-24)}`);

  it('gives Claude Code and Codex marks of their own: no two tools share a logo', () => {
    expect(mark('claude-code', 'Claude Code')).not.toEqual(mark('claude-ai', 'Claude.ai'));
    expect(mark('codex', 'Codex')).not.toEqual(mark('chatgpt', 'ChatGPT'));
    expect(mark('claude-code', 'Claude Code')).toContain('is-letters');
    expect(mark('codex-cli', 'Codex CLI')).toContain('is-letters');
    expect(mark('claude-ai', 'Claude.ai')).toContain('<img');
    expect(mark('chatgpt', 'ChatGPT')).toContain('<img');
  });

  it('never draws the same mark for two different tools', () => {
    const seen = new Map<string, string>();
    for (const [id, name] of TOOLS) {
      const drawn = mark(id, name);
      const same = SAME_TOOL.find(pair => pair.includes(id));
      const earlier = seen.get(drawn);
      if (earlier) expect(same?.includes(earlier), `${name} and ${earlier} share ${drawn}`).toBe(true);
      seen.set(drawn, id);
    }
  });
});

describe('setup import Stop (E9)', () => {
  const running = { state: 'running', percent: 48, imported: 61, error: null, sent: 61, total: 128 };
  const buttons = (html: string) => html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const stopButton = (html: string) => buttons(html).find(button => button.replace(/<[^>]+>/g, '').includes('Stop'));
  const panel = (html: string) => html.match(/<section class="panel is-memory history-panel"[\s\S]*?<\/section>/)?.[0] ?? '';

  it('offers "Stop import" while the upload runs: outlined, in the bottom row, with Back waiting beside it', () => {
    const html = app.renderImport(running);
    const stop = stopButton(html)!;
    expect(stop).toContain('>Stop import</button>');
    expect(stop).toMatch(/class="[^"]*\bsecondary\b/);
    expect(stop).toContain('data-activity="ready"');
    expect(stop).not.toContain('aria-busy="true"');
    expect(html.indexOf(stop)).toBeGreaterThan(html.indexOf('setup-actions-forward'));
    // Stopping is not the way forward: the screen keeps no navy button.
    expect(navyButtons(html)).toEqual([]);
    expect(html).toContain('<p id="setup-waiting-line" class="setup-waiting">Back waits while the import runs.</p>');
  });

  it('says it is stopping while the Stop is on its way, and takes no second press', () => {
    const stop = stopButton(app.renderImport(running, true))!;
    expect(stop).toContain('aria-busy="true"');
    expect(stop).toContain('data-slot="button-spinner"');
    expect(stop.replace(/<[^>]+>/g, '')).toBe('Stopping…');
  });

  it('shows on Finish Setup how far the stopped run got, what was on its way, and that nothing was deleted', () => {
    const stopped = panel(app.renderHistoryPanel({ ...running, state: 'stopped', sent: 51, total: 128, unconfirmed: 77 }));
    expect(stopped).toContain('You stopped the import.');
    // "Sent" counts the memories cmem.ai skipped too (already there, or unreadable), so no line says they all arrived.
    expect(stopped).toContain('51 of 128 memories were sent before you stopped.');
    expect(stopped).not.toContain('reached');
    expect(stopped).toContain('77 more were on their way when you stopped. cmem.ai may have saved some of them.');
    expect(stopped).toContain('Nothing was deleted on this computer or in your account. Importing again skips memories already there.');
    // Continue is the person's choice: the offer stays, behind its tick box.
    expect(stopped).toContain('Add saved memories');
    expect(stopped).toContain('Tick the box above to turn this on.');
    // A stop the person chose is a status, not an error.
    expect(stopped).toContain('role="status"');
    expect(stopped).not.toContain('role="alert"');
    expect(panel(app.renderHistoryPanel({ ...running, state: 'stopped', sent: 127, total: 128, unconfirmed: 1 })))
      .toContain('1 more was on its way when you stopped. cmem.ai may have saved it.');
    // Stopped between batches (or by an older worker): nothing unknown to report.
    expect(panel(app.renderHistoryPanel({ ...running, state: 'stopped' }))).not.toContain('on its way');
  });

  it('says what a finished run added and what the others were, never calling a skipped memory added', () => {
    const done = { state: 'done', percent: 100, error: null, sent: 128, total: 128 };
    const added = (imported: number, sent: number) => `This import added ${imported} of ${sent} memories to your CMEM account · Ready to search.`;
    // Continue after a Stop at 100 of 128 sent: the worker's numbers (history-import-stop.test.ts, the batch on its way
    // never saved, then saved before the cancel). After the import screen, and after a reload once it finished.
    for (const status of ['complete', 'available']) {
      const receipt = panel(app.renderHistoryPanel({ ...done, imported: 28, skipped: 100 }, status));
      expect(receipt, status).toContain(added(28, 128));
      expect(receipt, status).toContain('The other 100 were already there, or cmem.ai couldn’t read them.');
      expect(receipt, status).not.toContain('28 memories imported');
    }
    const allThere = panel(app.renderHistoryPanel({ ...done, imported: 0, skipped: 128 }, 'complete'));
    expect(allThere).toContain(added(0, 128));
    expect(allThere).toContain('The other 128 were already there, or cmem.ai couldn’t read them.');
    expect(panel(app.renderHistoryPanel({ ...done, imported: 127, skipped: 1 }, 'complete'))).toContain('The other 1 was already there, or cmem.ai couldn’t read it.');
    // Every memory new: one line, as before E9. A worker that sends no skipped count gets the same line.
    for (const result of [{ ...done, imported: 128, skipped: 0 }, { ...done, imported: 128 }]) {
      const plain = panel(app.renderHistoryPanel(result, 'complete'));
      expect(plain).toContain('128 memories imported to your CMEM account · Ready to search.');
      expect(plain).not.toContain('The other');
    }
  });

  it('offers Stop import on Finish Setup for a run found running (after a reload), with no tick box in its way', () => {
    const html = panel(app.renderHistoryPanel(running));
    const line = html.match(/<div class="history-running">[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(line).toContain('An import is already running.');
    const stop = stopButton(line)!;
    expect(stop).toContain('>Stop import</button>');
    expect(stop).toMatch(/class="[^"]*\bsecondary\b/);
    // Attributes, not the class list's `aria-disabled:` styles.
    expect(stop).not.toMatch(/\saria-disabled="/);
    expect(stop).not.toMatch(/\saria-describedby="/);
    // The tick box and its hint stay, for starting an import; Stop does not wait for them.
    expect(html).toContain('Tick the box above to turn this on.');
    // While its request is on its way it says so and takes no second press.
    const busy = stopButton(panel(app.renderHistoryPanel(running, 'available', true)))!;
    expect(busy).toContain('aria-busy="true"');
    expect(busy.replace(/<[^>]+>/g, '')).toBe('Stopping…');
  });

  it('words a failed run as a failure, not as the person\'s own Stop', () => {
    const failed = panel(app.renderHistoryPanel({ ...running, state: 'failed', error: 'cmem.ai refused the import (HTTP 503).' }));
    expect(failed).toContain('The import couldn’t finish.');
    expect(failed).toContain('role="alert"');
    expect(failed).not.toMatch(/stop/i);
  });

  it('words every run state the page can show, from the one definition', () => {
    const offerOnly = panel(app.renderHistoryPanel(null));
    const states = app.HISTORY_IMPORT_RUN_STATES.filter((state: string) => state !== 'idle');
    expect(states).toContain('stopped');
    const words = states.map((state: string) => {
      const html = panel(app.renderHistoryPanel({ ...running, state, error: state === 'failed' ? 'cmem.ai refused the import (HTTP 503).' : null }));
      expect(html, state).not.toEqual(offerOnly);
      return html;
    });
    expect(new Set(words).size).toBe(states.length);
  });
});
