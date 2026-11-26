// The installer's side of the install funnel: open the setup page, wait for the storage choice, apply it, then wait
// until the page finishes setup. The worker holds the state (GET /api/setup/state); the terminal only waits.
// There is no overall time limit for the person: the URL is printed once the worker answers, and if the browser
// never connects the wait goes on. Individual worker requests are bounded so an unresponsive connection cannot pin
// a poll or keep the installer waiting after checkout has finished.
import type { SetupCheckoutState, SetupChoice, SetupDeviceCode, SetupInstallerStage, SetupStateView } from '../../shared/setup-state.js';
import type { SetupInstallCatalog, SetupInstallSelection, SetupInstallStatus } from '../../shared/setup-install.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { settingsTarget, type SettingsDocument } from '../../shared/settings-document.js';

// Every request here goes to the local worker on loopback, and these routes answer from a small local JSON file
// (WorkViewRoutes setup-state handlers), so 5 s only trips on a stalled connection, never on a slow answer. Same
// budget as READ_TIMEOUT_MS in usage-summary.ts for the installer's other loopback reads.
const WORKER_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Puts the code of the pairing the open checkout waits on beside "Waiting for this device to connect…" on the setup
 * page. A resumed installer runs hidden, so the page is the only place the person can see it.
 */
export type ShowDeviceCode = (code: SetupDeviceCode) => Promise<void>;

/** On The Go checkout on the existing pairing path (funnel Phase 8). */
export interface BrowserCheckout {
  /**
   * Opens the pairing's checkout and waits for it however long it takes; true once paid and the settings are saved.
   * Shows each pairing's code before opening that pairing's page.
   */
  run: (showCode: ShowDeviceCode) => Promise<boolean>;
  /** The page asked again while a checkout is open: open the same checkout page again (a fresh one once it expired). */
  reopen: (showCode: ShowDeviceCode) => void | Promise<void>;
}

/** What the checkout needs of a pairing (install.ts InstallerOAuthPairing). `expiresAt` is epoch ms. */
export interface CheckoutPairing { userCode: string; checkoutUrl: string; expiresAt?: number }

export function deviceCodeOf(pairing: CheckoutPairing): SetupDeviceCode {
  return { userCode: pairing.userCode, expiresAt: pairing.expiresAt === undefined ? null : new Date(pairing.expiresAt).toISOString() };
}

/**
 * On The Go's checkout on the pairing the installer holds; install.ts wires cmem.ai into it. The pairing the choice
 * started is held for the first ask. A pairing whose checkout failed, or one past its expiry, is never opened again:
 * the next ask, or a reopen after the expiry, starts a fresh pairing with a new code. Without an expiry from cmem.ai,
 * a reopen opens the same page, as before.
 */
export function createPairingCheckout<P extends CheckoutPairing>(deps: {
  /** Starts a new pairing (startOnTheGoPairing). Throws when cmem.ai cannot start one. */
  start: () => Promise<P>;
  /**
   * Opens the pairing's page and notes its code unless `opened`, waits for it, and saves what it delivers: true once
   * paid. `superseded` answers true once a fresh pairing replaced this one, so its wait ends without a timeout notice.
   */
  complete: (pairing: P, opened: boolean, superseded: () => Promise<boolean>) => Promise<boolean>;
  /** Prints the code in the terminal, as `complete` does for a page it opens itself. */
  noteCode: (pairing: P) => void;
  openBrowser: (url: string) => void;
  log: { warn: (message: string) => void };
  now?: () => number;
}): BrowserCheckout & { hold: (pairing: P) => void } {
  const now = deps.now ?? Date.now;
  const expired = (pairing: P) => pairing.expiresAt !== undefined && now() >= pairing.expiresAt;
  let held: P | null = null;
  // A reopen after the held pairing expired starts its replacement here, and the open checkout moves on to it: the
  // old pairing's wait ends at that same expiry.
  let replacement: Promise<P | null> | null = null;
  // Each run of the checkout, and whether it still waits. A replacement still starting once its run has returned
  // (paid, failed or thrown) is dropped, so a pairing approved meanwhile never gets a second code or checkout tab.
  let runs = 0;
  let running = false;
  return {
    hold: (pairing) => { held = pairing; },
    run: async (showCode) => {
      runs++;
      running = true;
      // A replacement left by an earlier run belongs to that run.
      replacement = null;
      try {
        if (!held || expired(held)) held = await deps.start();
        let pairing: P = held;
        let opened = false;
        for (;;) {
          await showCode(deviceCodeOf(pairing));
          const current = pairing;
          // The replacement a reopen is starting for this pairing, if any: its wait then ends quietly.
          const superseded = async () => {
            const next = replacement ? await replacement : null;
            return next !== null && next !== current;
          };
          if (await deps.complete(pairing, opened, superseded)) return true;
          const next = replacement ? await replacement : null;
          replacement = null;
          if (!next) { held = null; return false; }
          pairing = next;
          opened = true;
        }
      } finally {
        running = false;
      }
    },
    reopen: async (showCode) => {
      const pairing = held;
      if (!pairing) return;
      if (!expired(pairing)) { deps.openBrowser(pairing.checkoutUrl); return; }
      // One replacement at a time: it opens its own page once cmem.ai answers.
      if (replacement) { await replacement; return; }
      const forRun = runs;
      const settled = () => !running || runs !== forRun;
      replacement = (async () => {
        let fresh: P;
        try {
          fresh = await deps.start();
        } catch (error) {
          // The expired checkout then reports failed, and the page's next ask tries a fresh pairing again.
          deps.log.warn(error instanceof Error ? error.message : String(error));
          return null;
        }
        // The old pairing was approved while cmem.ai started this one: nothing waits on it.
        if (settled()) return null;
        held = fresh;
        deps.noteCode(fresh);
        // The terminal has the code (noteCode); a worker that did not take it must not stop the fresh pairing.
        try {
          await showCode(deviceCodeOf(fresh));
        } catch (error) {
          deps.log.warn(`Could not show the device code on the setup page: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (settled()) return null;
        deps.openBrowser(fresh.checkoutUrl);
        return fresh;
      })();
      await replacement;
    },
  };
}

/**
 * GUI mode: a person at a terminal, with nothing on the command line that already answers the setup questions.
 * Non-TTY (agent-run) installs, `--provider`, `--no-auto-start` and the server runtime keep the terminal flow, and
 * a plain interactive reinstall also opens the GUI after the optional terminal signup. `npx claude-mem update` on a
 * machine keeps the terminal: it reuses installed choices and asks only for missing configuration there.
 */
export function shouldUseBrowserSetup(input: {
  interactive: boolean;
  provider?: string;
  noAutoStart?: boolean;
  runtime: 'worker' | 'server';
  setupComplete: boolean;
  update?: boolean;
}): boolean {
  if (input.update) return false;
  return input.interactive && !input.provider && !input.noAutoStart && input.runtime === 'worker';
}

/**
 * After an unattended (non-TTY) install that would have opened browser setup in a terminal, tell the agent how to
 * re-run it so the user gets that setup. Only a fresh, fully successful worker install with no provider chosen
 * (`--provider` or a persisted one) and auto-start on qualifies, and never under CI.
 */
export function shouldPrintAgentBrowserSetupHint(input: {
  ci: boolean;
  alreadyInstalled: boolean;
  setupComplete: boolean;
  failedIdeCount: number;
  providerSource?: string;
  runtime: 'worker' | 'server';
  noAutoStart?: boolean;
}): boolean {
  return !input.ci && !input.alreadyInstalled && !input.setupComplete && input.failedIdeCount === 0
    && input.providerSource === 'default' && input.runtime === 'worker' && !input.noAutoStart;
}

export const AGENT_BROWSER_SETUP_HINT =
  "AGENT: If the user is available, run npx claude-mem install --setup browser on their computer. Open the printed setup URL if needed and keep the installer running. If the user is unavailable, use --setup defer and show them the saved setup URL at their first interaction.";

export interface BrowserSetupDeps {
  /** e.g. http://127.0.0.1:37777 */
  workerBaseUrl: string;
  openBrowser: (url: string) => void;
  log: { info: (message: string) => void; warn: (message: string) => void };
  /** Install choices are collected before the memory/storage part of setup. */
  install?: { catalog: SetupInstallCatalog; apply: (selection: SetupInstallSelection) => Promise<void> };
  /** The worker launched a local continuation after deferred setup was submitted. */
  resume?: boolean;
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
  const noteUnreachable = (): null => {
    if (!unreachableNoted) deps.log.warn(`Waiting for the worker at ${deps.workerBaseUrl}…`);
    unreachableNoted = true;
    return null;
  };

  /** A worker that is still starting (or restarting) is waited for; a refusal from it is an error. */
  const readState = async (): Promise<SetupStateView | null> => {
    const signal = AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await request(stateUrl, { cache: 'no-store', signal });
    } catch {
      return noteUnreachable();
    }
    if (!response.ok) throw await workerResponseError(response, 'The worker refused the setup state');
    try {
      const state = await response.json() as SetupStateView;
      unreachableNoted = false;
      return state;
    } catch (error) {
      // A request can stall after its headers. Keep waiting for the worker on
      // deadline expiry, but surface malformed JSON instead of retrying it.
      if (!signal.aborted) throw error;
      return noteUnreachable();
    }
  };
  const waitFor = async (done: (state: SetupStateView) => boolean): Promise<SetupStateView> => {
    for (;;) {
      const state = await readState();
      if (state && done(state)) return state;
      await sleep(pollIntervalMs);
    }
  };
  const report = async (stage: SetupInstallerStage, error: string | null = null, checkout?: Exclude<SetupCheckoutState, 'requested'>, deviceCode?: SetupDeviceCode | null): Promise<void> => {
    const response = await request(`${deps.workerBaseUrl}/api/setup/installer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Only a waiting checkout carries the code; paid and failed reports leave it out, which clears it.
      body: JSON.stringify(checkout ? { stage, error, checkout, ...(checkout === 'waiting' && deviceCode ? { deviceCode } : {}) } : { stage, error }),
      signal: AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw await workerResponseError(response, `The worker did not take the installer stage ${stage}`);
    // The report response has no data the installer needs.
    await response.body?.cancel().catch(() => {});
  };

  const url = setupPageUrl(deps.workerBaseUrl);
  const reportInstall = async (status: SetupInstallStatus, error: string | null = null): Promise<void> => {
    const response = await request(`${deps.workerBaseUrl}/api/setup/install/installer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, error, ...(status === 'waiting' ? { catalog: deps.install!.catalog } : {}) }),
      signal: AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw await workerResponseError(response, 'The worker did not accept the installation progress');
    await response.body?.cancel().catch(() => {});
  };
  // Clear the previous run before exposing the page: opening it (or following the
  // printed URL) can submit a new choice before a later reset would arrive.
  const opening = await waitFor(() => true);
  if (!deps.resume) {
    await report('waiting-for-choice');
    if (deps.install) await reportInstall('waiting');
  } else if (!opening.installer && !opening.choice) {
    await report('waiting-for-choice');
  }
  deps.log.info(`Continue setup in your browser: ${url}`);
  if (!deps.resume) deps.openBrowser(url);
  deps.log.info('Waiting for you in the browser. This terminal finishes when setup does.');

  if (deps.install) {
    for (;;) {
      const state = await waitFor(current => current.install?.status === 'ready'
        || current.install?.status === 'installing' && !!current.install.selection);
      if (state.install?.status === 'ready') break;
      try {
        await deps.install.apply(state.install!.selection!);
      } catch (error) {
        await reportInstall('failed', error instanceof Error ? error.message : String(error));
        continue; // Only a new, explicit browser submission authorizes another attempt.
      }
      await reportInstall('ready');
      break;
    }
  }

  let chosen = await waitFor((state) => state.choice !== null);
  let choice = chosen.choice as SetupChoice;
  let stage: SetupInstallerStage;
  for (;;) {
    try {
      stage = await deps.applyChoice(choice, chosen);
      break;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await report('failed', message);
      // A new browser submission, even of the same branch, explicitly authorizes retry.
      chosen = await waitFor(state => state.choice !== null && state.choice.chosenAt !== choice.chosenAt);
      choice = chosen.choice as SetupChoice;
    }
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
    // A new run may start a new pairing, so no code shows until the run says which pairing it waits on.
    let deviceCode = null as SetupDeviceCode | null;
    await report(stage, null, 'waiting');
    let settled = false;
    // Every waiting report from here on carries the code of the pairing the open checkout waits on.
    const showCode: ShowDeviceCode = async (code) => {
      deviceCode = code;
      if (!settled) await report(stage, null, 'waiting', code);
    };
    // While the checkout is open, a repeat Continue on the page opens it again.
    const watchForRepeats = (async () => {
      while (!settled) {
        await sleep(pollIntervalMs);
        const current = settled ? null : await readState();
        if (current && newRequest(current)) {
          handledRequests = current.checkout!.requests;
          await deps.checkout!.reopen(showCode);
          // A reopen past the pairing's expiry that started no fresh pairing leaves a dead code: the page shows none.
          if (deviceCode?.expiresAt && Date.now() >= Date.parse(deviceCode.expiresAt)) deviceCode = null;
          if (!settled) await report(stage, null, 'waiting', deviceCode);
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
    try { checkoutPaid = await deps.checkout!.run(showCode); }
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
 * A read that hits the per-request deadline is a busy worker, not a finished one: poll again. Losing contact
 * (a refused connection), a refusal or malformed state cannot prove work finished: fail visibly and leave the
 * worker running.
 */
export async function waitForBackgroundWorkToFinish(deps: Pick<BrowserSetupDeps, 'workerBaseUrl' | 'log' | 'fetch' | 'sleep' | 'pollIntervalMs'>): Promise<void> {
  const request = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let announced = '';
  let slowNoted = false;
  const readFailed = (error: unknown) =>
    new Error(`Could not read the worker's background work state: ${error instanceof Error ? error.message : String(error)}`);
  // A late answer means the worker is busy (goal extraction, history import), not that its work finished.
  const waitForSlowWorker = async () => {
    if (!slowNoted) deps.log.warn('Waiting for the worker to answer…');
    slowNoted = true;
    await sleep(deps.pollIntervalMs ?? 1000);
  };
  for (;;) {
    const signal = AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await request(`${deps.workerBaseUrl}/api/setup/state`, { cache: 'no-store', signal });
    } catch (error) {
      if (signal.aborted) { await waitForSlowWorker(); continue; }
      throw readFailed(error);
    }
    if (!response.ok) throw await workerResponseError(response, 'The worker refused the background work state');
    let state: SetupStateView;
    try {
      state = await response.json() as SetupStateView;
    } catch (error) {
      if (signal.aborted) { await waitForSlowWorker(); continue; }
      throw readFailed(error);
    }
    slowNoted = false;
    const running = state.backgroundWorkRunning ?? [];
    if (!running.length) return;
    const doing = running.map(work => BACKGROUND_WORK_LABELS[work]).join(' and ');
    if (doing !== announced) {
      deps.log.info(`Setup is complete. The worker restarts to apply your settings once it finishes ${doing}; that work keeps going until then.`);
      announced = doing;
    }
    await sleep(deps.pollIntervalMs ?? 1000);
  }
}
