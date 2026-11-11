import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { AGENT_BROWSER_SETUP_HINT, runBrowserSetup, settingsChangesNeedingRestart, setupPageUrl, shouldPrintAgentBrowserSetupHint, shouldUseBrowserSetup, waitForBackgroundWorkToFinish } from '../../src/npx-cli/install/browser-setup.js';
import type { SetupStateView } from '../../src/shared/setup-state.js';
import type { SetupInstallCatalog } from '../../src/shared/setup-install.js';

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
  it('also uses the GUI to reconfigure an existing installation', () => {
    expect(shouldUseBrowserSetup({ ...GUI, setupComplete: true })).toBe(true);
  });
});

const FRESH_AGENT_INSTALL = {
  ci: false,
  alreadyInstalled: false,
  setupComplete: false,
  failedIdeCount: 0,
  providerSource: 'default',
  runtime: 'worker' as const,
};

describe('shouldPrintAgentBrowserSetupHint', () => {
  it('tells the agent how to reach browser setup after a fresh unattended worker install', () => {
    expect(shouldPrintAgentBrowserSetupHint(FRESH_AGENT_INSTALL)).toBe(true);
    expect(AGENT_BROWSER_SETUP_HINT).toStartWith('AGENT: ');
    expect(AGENT_BROWSER_SETUP_HINT).toContain('npx claude-mem install --setup browser');
    expect(AGENT_BROWSER_SETUP_HINT).toContain('--setup defer');
  });
  it('stays quiet under CI', () => {
    expect(shouldPrintAgentBrowserSetupHint({ ...FRESH_AGENT_INSTALL, ci: true })).toBe(false);
  });
  it('stays quiet when a provider was chosen by flag or reused from settings', () => {
    expect(shouldPrintAgentBrowserSetupHint({ ...FRESH_AGENT_INSTALL, providerSource: 'flag' })).toBe(false);
    expect(shouldPrintAgentBrowserSetupHint({ ...FRESH_AGENT_INSTALL, providerSource: 'persisted' })).toBe(false);
    expect(shouldPrintAgentBrowserSetupHint({ ...FRESH_AGENT_INSTALL, providerSource: undefined })).toBe(false);
  });
  it('stays quiet on a reinstall, after setup finished, or after an IDE setup failure', () => {
    expect(shouldPrintAgentBrowserSetupHint({ ...FRESH_AGENT_INSTALL, alreadyInstalled: true })).toBe(false);
    expect(shouldPrintAgentBrowserSetupHint({ ...FRESH_AGENT_INSTALL, setupComplete: true })).toBe(false);
    expect(shouldPrintAgentBrowserSetupHint({ ...FRESH_AGENT_INSTALL, failedIdeCount: 1 })).toBe(false);
  });
  it('stays quiet for the server runtime and --no-auto-start, which never use browser setup', () => {
    expect(shouldPrintAgentBrowserSetupHint({ ...FRESH_AGENT_INSTALL, runtime: 'server' })).toBe(false);
    expect(shouldPrintAgentBrowserSetupHint({ ...FRESH_AGENT_INSTALL, noAutoStart: true })).toBe(false);
  });
});

/** A worker that answers from a scripted state, the way the page and installer would move it. */
function fakeWorker(script: { unreachableReads?: number }) {
  let state: SetupStateView = { status: 'pending', choice: null, installer: null, completedAt: null, alreadyPro: false };
  let unreachable = script.unreachableReads ?? 0;
  const stages: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/setup/install/installer')) {
      const body = JSON.parse(String(init?.body));
      state = { ...state, install: { catalog: body.catalog ?? state.install!.catalog,
        status: body.status, selection: body.status === 'waiting' ? null : state.install?.selection ?? null, error: body.error } };
      return Response.json(state);
    }
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
  const catalog: SetupInstallCatalog = {
    agents: [{ id: 'codex-cli', label: 'Codex CLI', hint: '', detected: true }], skills: [], reinstall: false,
    defaults: { agents: ['codex-cli'], skills: [], installClaudeCode: false, disableAutoMemory: false, telemetryEnabled: false },
  };

  it('waits for browser install choices before applying memory configuration and retries only on a new submission', async () => {
    const worker = fakeWorker({});
    let attempts = 0;
    let failureSeen = false;
    let memoryApplied = false;
    const result = await runBrowserSetup({
      workerBaseUrl: 'http://127.0.0.1:1234', openBrowser: () => {}, log: { info: () => {}, warn: () => {} }, fetch: worker.fetch,
      install: { catalog, apply: async selection => {
        expect(selection.agents).toEqual(['codex-cli']);
        if (++attempts === 1) throw new Error('Try again');
      } },
      sleep: async () => {
        const state = worker.get();
        if (state.install?.status === 'waiting' || state.install?.status === 'failed') {
          if (state.install.status === 'failed') {
            failureSeen = true;
            expect(state.install.error).toBe('Try again');
            expect(attempts).toBe(1);
          }
          worker.set({ install: { ...state.install, status: 'installing', selection: catalog.defaults } });
        } else if (state.install?.status === 'ready' && !state.choice) {
          worker.set({ choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'now' } });
        } else if (memoryApplied) worker.set({ status: 'complete' });
      },
      applyChoice: async () => { expect(worker.get().install?.status).toBe('ready'); memoryApplied = true; return 'home-ready'; },
    });
    expect(result.state.status).toBe('complete');
    expect(attempts).toBe(2);
    expect(failureSeen).toBe(true);
  });

  for (const status of ['installing', 'ready'] as const) it(`resumes ${status} setup without resetting it or opening another browser`, async () => {
    const worker = fakeWorker({});
    worker.set({ install: { catalog, status, selection: catalog.defaults, error: null },
      choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'now' } });
    let applied = false;
    await runBrowserSetup({
      workerBaseUrl: 'http://127.0.0.1:1234', resume: true,
      openBrowser: () => { throw new Error('resume must keep the existing page'); },
      log: { info: () => {}, warn: () => {} }, fetch: worker.fetch,
      install: { catalog, apply: async () => { applied = true; } },
      applyChoice: async () => 'home-ready', sleep: async () => { worker.set({ status: 'complete' }); },
    });
    expect(applied).toBe(status === 'installing');
    expect(worker.stages).toEqual(['home-ready']);
  });
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

  it('reports a failed choice and retries only after the browser submits another choice', async () => {
    const worker = fakeWorker({});
    let sleeps = 0;
    let attempts = 0;
    await runBrowserSetup({
      workerBaseUrl: 'http://127.0.0.1:1234',
      openBrowser: () => {},
      log: { info: () => {}, warn: () => {} },
      fetch: worker.fetch,
      sleep: async () => {
        if (++sleeps === 2) worker.set({ choice: { branch: 'go', memoryBilling: 'hosted', chosenAt: 'now' } });
        if (worker.get().installer?.stage === 'failed') {
          expect(attempts).toBe(1);
          expect(worker.get().installer?.error).toBe('Could not start the CMEM Pro sign-in.');
          worker.set({ choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'later' } });
        }
        if (worker.get().installer?.stage === 'home-ready') worker.set({ status: 'complete' });
      },
      applyChoice: async () => {
        if (++attempts === 1) throw new Error('Could not start the CMEM Pro sign-in.');
        return 'home-ready';
      },
    });
    expect(worker.stages).toEqual(['waiting-for-choice', 'failed', 'home-ready']);
    expect(attempts).toBe(2);
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
