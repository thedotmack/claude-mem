import { describe, expect, it } from 'bun:test';
import { runBrowserSetup, setupPageUrl, shouldUseBrowserSetup } from '../../src/npx-cli/install/browser-setup.js';
import type { SetupStateView } from '../../src/shared/setup-state.js';

const GUI = { interactive: true, runtime: 'worker' as const, setupComplete: false };

describe('shouldUseBrowserSetup', () => {
  it('hands an interactive install with no provider to the browser', () => {
    expect(shouldUseBrowserSetup(GUI)).toBe(true);
  });
  it('keeps the terminal flow for non-TTY (agent-run) installs', () => {
    expect(shouldUseBrowserSetup({ ...GUI, interactive: false })).toBe(false);
  });
  it('keeps the terminal flow for --provider claude and every other --provider', () => {
    expect(shouldUseBrowserSetup({ ...GUI, provider: 'claude' })).toBe(false);
    expect(shouldUseBrowserSetup({ ...GUI, provider: 'openrouter' })).toBe(false);
  });
  it('keeps the terminal flow for --no-auto-start and the server runtime', () => {
    expect(shouldUseBrowserSetup({ ...GUI, noAutoStart: true })).toBe(false);
    expect(shouldUseBrowserSetup({ ...GUI, runtime: 'server' })).toBe(false);
  });
  it('shows the funnel once per machine', () => {
    expect(shouldUseBrowserSetup({ ...GUI, setupComplete: true })).toBe(false);
  });
});

/** A worker that answers from a scripted state, the way the page and installer would move it. */
function fakeWorker(script: { unreachableReads?: number }) {
  let state: SetupStateView = { status: 'pending', choice: null, installer: null, completedAt: null, alreadyPro: false };
  let unreachable = script.unreachableReads ?? 0;
  const stages: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/setup/installer')) {
      const body = JSON.parse(String(init?.body));
      stages.push(body.stage);
      state = { ...state, ...(body.stage === 'waiting-for-choice' ? { choice: null } : {}), installer: { stage: body.stage, error: body.error, updatedAt: 'now' } };
      return Response.json(state);
    }
    if (unreachable > 0) { unreachable--; throw new TypeError('fetch failed'); }
    return Response.json(state);
  }) as typeof globalThis.fetch;
  return { fetch, stages, set: (changes: Partial<SetupStateView>) => { state = { ...state, ...changes }; }, get: () => state };
}

describe('runBrowserSetup', () => {
  it('opens the page, waits without a time limit for the worker and the choice, then for the finish', async () => {
    const worker = fakeWorker({ unreachableReads: 3 });
    const opened: string[] = [];
    const warnings: string[] = [];
    let sleeps = 0;
    const applied: string[] = [];
    const outcome = await runBrowserSetup({
      workerBaseUrl: 'http://127.0.0.1:1234',
      openBrowser: (url) => opened.push(url),
      log: { info: () => {}, warn: (message) => warnings.push(message) },
      fetch: worker.fetch,
      sleep: async () => {
        sleeps++;
        // The browser connects late, then chooses, then finishes.
        if (sleeps === 10) worker.set({ choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'now' } });
        if (sleeps === 20) worker.set({ status: 'complete', completedAt: 'now' });
      },
      applyChoice: async (choice) => { applied.push(choice.branch); return 'home-ready'; },
    });
    expect(opened).toEqual([setupPageUrl('http://127.0.0.1:1234')]);
    expect(opened[0]).toBe('http://127.0.0.1:1234/?setup=1');
    expect(warnings).toEqual(['Waiting for the worker at http://127.0.0.1:1234…']);
    expect(applied).toEqual(['home']);
    expect(worker.stages).toEqual(['waiting-for-choice', 'home-ready']);
    expect(outcome).toMatchObject({ choice: { branch: 'home' }, stage: 'home-ready', state: { status: 'complete' } });
  });

  it('reports a failed choice to the page and stops', async () => {
    const worker = fakeWorker({});
    let sleeps = 0;
    await expect(runBrowserSetup({
      workerBaseUrl: 'http://127.0.0.1:1234',
      openBrowser: () => {},
      log: { info: () => {}, warn: () => {} },
      fetch: worker.fetch,
      sleep: async () => { if (++sleeps === 2) worker.set({ choice: { branch: 'go', memoryBilling: 'hosted', chosenAt: 'now' } }); },
      applyChoice: async () => { throw new Error('Could not start the CMEM Pro sign-in.'); },
    })).rejects.toThrow('Could not start the CMEM Pro sign-in.');
    expect(worker.stages).toEqual(['waiting-for-choice', 'failed']);
    expect(worker.get().installer?.error).toBe('Could not start the CMEM Pro sign-in.');
  });
});
