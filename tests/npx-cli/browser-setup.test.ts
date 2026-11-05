import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runBrowserSetup, settingsChangesNeedingRestart, setupPageUrl, shouldUseBrowserSetup, waitForBackgroundWorkToFinish } from '../../src/npx-cli/install/browser-setup.js';
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
  it('handles a checkout watcher failure immediately, then preserves paid credentials and reports before rejecting', () => {
    const child = Bun.spawnSync([process.execPath, fileURLToPath(new URL('../fixtures/browser-setup-watcher-failure.ts', import.meta.url))], {
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.whileCheckoutOpen.unhandled).toEqual([]);
    expect(result.whileCheckoutOpen.setupSettled).toBe(false);
    expect(result.whileCheckoutOpen.credentialsPersisted).toBe(false);
    expect(result.whileCheckoutOpen.warnings).toHaveLength(1);
    expect(result.whileCheckoutOpen.warnings[0]).toContain('Checkout status service is unavailable.');
    expect(result.credentialsPersisted).toBe(true);
    expect(result.reports.at(-1)).toBe('paid');
    expect(result.error).toContain('Checkout status service is unavailable.');
  });

  for (const status of [403, 503]) {
    it(`surfaces the worker's setup-state error on HTTP ${status}`, async () => {
      await expect(runBrowserSetup({
        workerBaseUrl: 'http://127.0.0.1:1234', openBrowser: () => {},
        log: { info: () => {}, warn: () => {} },
        fetch: (async () => Response.json({ error: 'setup_unavailable', message: 'Setup is unavailable for this installation.' }, { status })) as typeof fetch,
        sleep: async () => { throw new Error('A refused request must not be silently retried.'); },
        applyChoice: async () => 'home-ready',
      })).rejects.toThrow('Setup is unavailable for this installation.');
    });
  }

  it('surfaces the worker error when an installer report is refused', async () => {
    const worker = fakeWorker({});
    await expect(runBrowserSetup({
      workerBaseUrl: 'http://127.0.0.1:1234', openBrowser: () => {},
      log: { info: () => {}, warn: () => {} },
      fetch: (async (url, init) => String(url).endsWith('/api/setup/installer')
        ? Response.json({ message: 'This installer session cannot update setup.' }, { status: 409 })
        : worker.fetch(url, init)) as typeof fetch,
      applyChoice: async () => 'home-ready',
    })).rejects.toThrow('This installer session cannot update setup.');
  });

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

describe('settingsChangesNeedingRestart', () => {
  const before = JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '37896', CLAUDE_MEM_RUNTIME: 'worker' });
  it('At Home needs no restart: the worker reads the provider, auth method and model live, and sync stays off', () => {
    // What useSubscriptionAuth() writes (buildAnthropicMaxLocalSettings): the scenario (b) settings file.
    const atHome = JSON.stringify({
      CLAUDE_MEM_WORKER_PORT: '37896', CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription',
      CLAUDE_MEM_MODEL: 'claude-sonnet-5', CLAUDE_MEM_CLOUD_SYNC_TOKEN: '', CLAUDE_MEM_CLOUD_SYNC_USER_ID: '', CLAUDE_MEM_CLOUD_SYNC_HUB_URL: '',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '', CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: '', CLAUDE_MEM_PRO_MEMORY_KEY: '', CLAUDE_MEM_PRO_MEMORY_BASE_URL: '', CLAUDE_MEM_PRO_MEMORY_MODEL: '',
    });
    expect(settingsChangesNeedingRestart(before, atHome)).toEqual([]);
    expect(settingsChangesNeedingRestart('', JSON.stringify({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: '' }))).toEqual([]);
    expect(settingsChangesNeedingRestart(before, before)).toEqual([]);
  });
  it('turning cloud sync on (On The Go paid) needs a restart: the worker sets up sync only at boot', () => {
    const paid = JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '37896', CLAUDE_MEM_CLOUD_SYNC_TOKEN: 't', CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'u', CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://cmem.ai/api/sync' });
    expect(settingsChangesNeedingRestart(before, paid)).toEqual(['CLAUDE_MEM_CLOUD_SYNC_HUB_URL', 'CLAUDE_MEM_CLOUD_SYNC_TOKEN', 'CLAUDE_MEM_CLOUD_SYNC_USER_ID']);
  });
  it('any other setting the worker reads at boot needs a restart', () => {
    expect(settingsChangesNeedingRestart(before, JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '37896', CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_CHROMA_ENABLED: 'false' }))).toEqual(['CLAUDE_MEM_CHROMA_ENABLED']);
  });
});

describe('waitForBackgroundWorkToFinish', () => {
  it('refuses to restart after losing contact with a running extraction', async () => {
    let reads = 0;
    await expect(waitForBackgroundWorkToFinish({
      workerBaseUrl: 'http://w', log: { info: () => {}, warn: () => {} }, sleep: async () => {},
      fetch: (async () => {
        if (++reads === 1) return Response.json({ backgroundWorkRunning: ['extraction'] });
        throw new Error('socket reset');
      }) as typeof fetch,
    })).rejects.toThrow('socket reset');
    expect(reads).toBe(2);
  });

  it('surfaces a refused state request instead of treating running work as finished', async () => {
    await expect(waitForBackgroundWorkToFinish({
      workerBaseUrl: 'http://w', log: { info: () => {}, warn: () => {} },
      fetch: (async () => Response.json({ error: 'Background work state could not be read.' }, { status: 503 })) as typeof fetch,
    })).rejects.toThrow('Background work state could not be read.');
  });

  it('waits, with no time limit, until no extraction or history import runs, and says why once per change', async () => {
    const answers = [['extraction'], ['extraction'], ['extraction', 'history-import'], []];
    let reads = 0, sleeps = 0;
    const said: string[] = [];
    await waitForBackgroundWorkToFinish({
      workerBaseUrl: 'http://w',
      fetch: (async () => Response.json({ backgroundWorkRunning: answers[reads++] })) as unknown as typeof fetch,
      sleep: async () => { sleeps++; },
      log: { info: line => said.push(line), warn: line => said.push(line) },
    });
    expect(reads).toBe(4);
    expect(sleeps).toBe(3);
    expect(said).toEqual([
      'Setup is complete. The worker restarts to apply your settings once it finishes reading your goals, work and rules; that work keeps going until then.',
      'Setup is complete. The worker restarts to apply your settings once it finishes reading your goals, work and rules and bringing your memory to CMEM; that work keeps going until then.',
    ]);
  });
  it('ends at once when the worker confirms nothing runs', async () => {
    const log = { info: () => {}, warn: () => {} };
    await waitForBackgroundWorkToFinish({ workerBaseUrl: 'http://w', log, fetch: (async () => Response.json({})) as unknown as typeof fetch, sleep: async () => { throw new Error('no wait'); } });
  });
});
