// The installer's side of the install funnel: open the setup page, wait for the storage choice, apply it, then wait
// until the page finishes setup. The worker holds the state (GET /api/setup/state); the terminal only waits.
// There is no time limit anywhere: if the browser never connects, the URL is on screen and the wait goes on.
import type { SetupChoice, SetupInstallerStage, SetupStateView } from '../../shared/setup-state.js';

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
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

export interface BrowserSetupOutcome {
  choice: SetupChoice;
  stage: SetupInstallerStage;
  state: SetupStateView;
}

export function setupPageUrl(workerBaseUrl: string): string {
  return `${workerBaseUrl}/?setup=1`;
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
    if (response.status >= 500) return null;
    if (!response.ok) throw new Error(`The worker refused the setup state (HTTP ${response.status}).`);
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
  const report = async (stage: SetupInstallerStage, error: string | null = null): Promise<void> => {
    const response = await request(`${deps.workerBaseUrl}/api/setup/installer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage, error }),
    });
    if (!response.ok) throw new Error(`The worker did not take the installer stage ${stage} (HTTP ${response.status}).`);
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

  const finished = await waitFor((state) => state.status === 'complete');
  return { choice, stage, state: finished };
}
