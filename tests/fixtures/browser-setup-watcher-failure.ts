// A separate process lets the regression observe unhandledRejection without changing the test runner's handlers.
import { runBrowserSetup } from '../../src/npx-cli/install/browser-setup.js';
import type { SetupStateView } from '../../src/shared/setup-state.js';

const unhandled: string[] = [];
const warnings: string[] = [];
const reports: string[] = [];
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
process.on('unhandledRejection', error => unhandled.push(errorMessage(error)));

let releaseCheckout!: () => void;
let noteReadFailure!: () => void;
const checkoutComplete = new Promise<void>(resolve => { releaseCheckout = resolve; });
const readFailed = new Promise<void>(resolve => { noteReadFailure = resolve; });
let checkoutStarted = false;
let credentialsPersisted = false;
let setupSettled = false;
let state: SetupStateView = {
  status: 'pending', choice: null, installer: null, checkout: null, tools: null, completedAt: null, alreadyPro: false,
};

const setup = runBrowserSetup({
  workerBaseUrl: 'http://fixture', openBrowser: () => {},
  log: { info: () => {}, warn: message => warnings.push(message) },
  sleep: () => new Promise(resolve => setImmediate(resolve)),
  fetch: (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const report = JSON.parse(String(init.body));
      reports.push(report.checkout ?? report.stage);
      if (report.stage === 'waiting-for-choice') {
        state.choice = { branch: 'go', memoryBilling: 'hosted', chosenAt: 'now' };
      } else if (report.stage === 'go-awaiting-checkout' && !report.checkout) {
        state.checkout = { state: 'requested', requests: 1, error: null, updatedAt: 'now' };
      }
      return Response.json(state);
    }
    if (checkoutStarted) {
      noteReadFailure();
      return Response.json({ error: 'setup_unavailable', message: 'Checkout status service is unavailable.' }, { status: 503 });
    }
    return Response.json(state);
  }) as typeof fetch,
  applyChoice: async () => 'go-awaiting-checkout',
  checkout: {
    run: async () => {
      checkoutStarted = true;
      await checkoutComplete;
      credentialsPersisted = true;
      return true;
    },
    reopen: () => {},
  },
}).then(
  () => { setupSettled = true; return null; },
  error => { setupSettled = true; return errorMessage(error); },
);

await readFailed;
// Advance full event-loop turns so an unhandled rejection would be reported while checkout remains held open.
await new Promise(resolve => setImmediate(resolve));
await new Promise(resolve => setImmediate(resolve));
const whileCheckoutOpen = { unhandled: [...unhandled], warnings: [...warnings], setupSettled, credentialsPersisted };
releaseCheckout();
const error = await setup;
process.stdout.write(JSON.stringify({ whileCheckoutOpen, credentialsPersisted, reports, error }));
