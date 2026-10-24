// The installer's side of the install funnel: open the setup page, wait for the storage choice, apply it, then wait
// until the page finishes setup. The worker holds the state (GET /api/setup/state); the terminal only waits.
// There is no time limit anywhere: if the browser never connects, the URL is on screen and the wait goes on.
import type { SetupCheckoutState, SetupChoice, SetupInstallerStage, SetupStateView } from '../../shared/setup-state.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { settingsTarget, type SettingsDocument } from '../../shared/settings-document.js';

/** On The Go checkout on the existing pairing path (funnel Phase 8). */
export interface BrowserCheckout {
  /** Opens the pairing's checkout and waits for it however long it takes; true once paid and the settings are saved. */
  run: () => Promise<boolean>;
  /** The page asked again while a checkout is open: open the same checkout page again. */
  reopen: () => void;
}

/**
 * GUI mode: a person at a terminal, with nothing on the command line that already answers the setup questions.
 * Non-TTY (agent-run) installs, `--provider`, `--no-auto-start` and the server runtime keep the terminal flow, and
 * a machine that already finished the funnel never sees it again.
 */
export function shouldUseBrowserSetup(input: {
  interactive: boolean;
  provider?: string;
  noAutoStart?: boolean;
  runtime: 'worker' | 'server';
  setupComplete: boolean;
}): boolean {
  return input.interactive && !input.provider && !input.noAutoStart && input.runtime === 'worker' && !input.setupComplete;
}

export interface BrowserSetupDeps {
  /** e.g. http://127.0.0.1:37777 */
  workerBaseUrl: string;
  openBrowser: (url: string) => void;
  log: { info: (message: string) => void; warn: (message: string) => void };
  /** Applies the choice and returns the stage to report. Throwing reports `failed` and ends the hand-off. */
  applyChoice: (choice: SetupChoice, state: SetupStateView) => Promise<SetupInstallerStage>;
  /** Runs when the page asks for checkout after the choice left the installer at `go-awaiting-checkout`. */
  checkout?: BrowserCheckout;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

export interface BrowserSetupOutcome {
  choice: SetupChoice;
  stage: SetupInstallerStage;
  state: SetupStateView;
  /** On The Go only: the checkout finished and the CMEM Pro settings were saved. */
  checkoutPaid: boolean;
}

export function setupPageUrl(workerBaseUrl: string): string {
  return `${workerBaseUrl}/?setup=1`;
}

async function workerResponseError(response: Response, action: string): Promise<Error> {
  const body = await response.text();
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.message === 'string') detail = parsed.message;
    else if (typeof parsed.error === 'string') detail = parsed.error;
  } catch { /* A plain-text server error is useful too. */ }
  return new Error(`${action} (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`);
}

export async function runBrowserSetup(deps: BrowserSetupDeps): Promise<BrowserSetupOutcome> {
  const request = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = deps.pollIntervalMs ?? 1000;
  const stateUrl = `${deps.workerBaseUrl}/api/setup/state`;
  let unreachableNoted = false;

  /** A worker that is still starting (or restarting) is waited for; a refusal from it is an error. */
  const readState = async (): Promise<SetupStateView | null> => {
    let response: Response;
    try {
      response = await request(stateUrl, { cache: 'no-store' });
    } catch {
      if (!unreachableNoted) deps.log.warn(`Waiting for the worker at ${deps.workerBaseUrl}…`);
      unreachableNoted = true;
      return null;
    }
    if (!response.ok) throw await workerResponseError(response, 'The worker refused the setup state');
    unreachableNoted = false;
    return await response.json() as SetupStateView;
  };
  const waitFor = async (done: (state: SetupStateView) => boolean): Promise<SetupStateView> => {
    for (;;) {
      const state = await readState();
      if (state && done(state)) return state;
      await sleep(pollIntervalMs);
    }
  };
  const report = async (stage: SetupInstallerStage, error: string | null = null, checkout?: Exclude<SetupCheckoutState, 'requested'>): Promise<void> => {
    const response = await request(`${deps.workerBaseUrl}/api/setup/installer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(checkout ? { stage, error, checkout } : { stage, error }),
    });
    if (!response.ok) throw await workerResponseError(response, `The worker did not take the installer stage ${stage}`);
  };

  const url = setupPageUrl(deps.workerBaseUrl);
  deps.log.info(`Continue setup in your browser: ${url}`);
  deps.openBrowser(url);
  // Wait for the worker before the first report, then start a fresh hand-off: an earlier run's choice is cleared.
  await waitFor(() => true);
  await report('waiting-for-choice');
  deps.log.info('Waiting for you in the browser. This terminal finishes when setup does.');

  const chosen = await waitFor((state) => state.choice !== null);
  const choice = chosen.choice as SetupChoice;
  let stage: SetupInstallerStage;
  try {
    stage = await deps.applyChoice(choice, chosen);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await report('failed', message);
    throw error;
  }
  await report(stage);

  // On The Go: each checkout the page asks for runs here, on the pairing the installer holds. A failed or cancelled
  // checkout is reported and the page can ask again; there is no time limit on either side.
  let handledRequests = 0;
  let checkoutPaid = false;
  const newRequest = (state: SetupStateView) => stage === 'go-awaiting-checkout' && !checkoutPaid && !!deps.checkout
    && state.checkout?.state === 'requested' && state.checkout.requests > handledRequests;
  for (;;) {
    const state = await waitFor((current) => current.status === 'complete' || newRequest(current));
    if (state.status === 'complete') return { choice, stage, state, checkoutPaid };
    handledRequests = state.checkout!.requests;
    await report(stage, null, 'waiting');
    let settled = false;
    // While the checkout is open, a repeat Continue on the page opens it again.
    const watchForRepeats = (async () => {
      while (!settled) {
        await sleep(pollIntervalMs);
        const current = settled ? null : await readState();
        if (current && newRequest(current)) {
          handledRequests = current.checkout!.requests;
          deps.checkout!.reopen();
          await report(stage, null, 'waiting');
        }
      }
    })().then(
      () => ({ ok: true as const }),
      (error: unknown) => {
        // Observe failures immediately without interrupting checkout before it persists paid credentials.
        const message = error instanceof Error ? error.message : String(error);
        deps.log.warn(`${message} Waiting for the open checkout to finish before stopping setup.`);
        return { ok: false as const, error };
      },
    );
    let failure: string | null = null;
    try { checkoutPaid = await deps.checkout!.run(); }
    catch (error: unknown) { failure = error instanceof Error ? error.message : String(error); }
    settled = true;
    const watcherOutcome = await watchForRepeats;
    if (checkoutPaid) await report(stage, null, 'paid');
    else await report(stage, failure ?? 'Checkout did not finish. Continue to open it again.', 'failed');
    if (!watcherOutcome.ok) throw watcherOutcome.error;
  }
}

/**
 * Settings a running worker reads from settings.json each time it uses them (provider-dispatch, the Claude provider),
 * so At Home's choice (provider, Claude auth method, model) takes effect with no restart.
 */
const SETTINGS_THE_WORKER_READS_LIVE = new Set(['CLAUDE_MEM_PROVIDER', 'CLAUDE_MEM_CLAUDE_AUTH_METHOD', 'CLAUDE_MEM_MODEL']);
const CLOUD_SYNC_SETTING_PREFIX = 'CLAUDE_MEM_CLOUD_SYNC_';

function effectiveSettings(snapshot: string): Record<string, string> {
  const document = snapshot.trim() ? settingsTarget(JSON.parse(snapshot.replace(/^\uFEFF/, '')) as SettingsDocument) : {};
  return { ...SettingsDefaultsManager.getAllDefaults(), ...document } as unknown as Record<string, string>;
}

const cloudSyncOn = (settings: Record<string, string>) => Boolean(settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN && settings.CLAUDE_MEM_CLOUD_SYNC_USER_ID
  && String(settings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL ?? '').trim());

/**
 * The settings the browser setup changed that the running worker only reads when it starts (cloud sync is set up at
 * boot), so they need a worker restart. Empty means the worker already runs with the new settings: no restart.
 * Cloud sync's keys count only when sync is on before or after (At Home writes them empty over the defaults).
 */
export function settingsChangesNeedingRestart(before: string, after: string): string[] {
  const previous = effectiveSettings(before), next = effectiveSettings(after);
  const syncMatters = cloudSyncOn(previous) || cloudSyncOn(next);
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])].filter(key => String(previous[key] ?? '') !== String(next[key] ?? ''))
    .filter(key => !SETTINGS_THE_WORKER_READS_LIVE.has(key) && (syncMatters || !key.startsWith(CLOUD_SYNC_SETTING_PREFIX)))
    .sort();
}

export const BACKGROUND_WORK_LABELS: Record<NonNullable<SetupStateView['backgroundWorkRunning']>[number], string> = {
  extraction: 'reading your goals, work and rules',
  'history-import': 'bringing your memory to CMEM',
};

/**
 * Waits, with no time limit, until the worker runs no extraction or history import, so a restart cannot kill one.
 * Losing contact cannot prove work finished: fail visibly and leave the worker running.
 */
export async function waitForBackgroundWorkToFinish(deps: Pick<BrowserSetupDeps, 'workerBaseUrl' | 'log' | 'fetch' | 'sleep' | 'pollIntervalMs'>): Promise<void> {
  const request = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let announced = '';
  for (;;) {
    let response: Response;
    try {
      response = await request(`${deps.workerBaseUrl}/api/setup/state`, { cache: 'no-store' });
    } catch (error) {
      throw new Error(`Could not read the worker's background work state: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw await workerResponseError(response, 'The worker refused the background work state');
    const running = ((await response.json()) as SetupStateView).backgroundWorkRunning ?? [];
    if (!running.length) return;
    const doing = running.map(work => BACKGROUND_WORK_LABELS[work]).join(' and ');
    if (doing !== announced) {
      deps.log.info(`Setup is complete. The worker restarts to apply your settings once it finishes ${doing}; that work keeps going until then.`);
      announced = doing;
    }
    await sleep(deps.pollIntervalMs ?? 1000);
  }
}
