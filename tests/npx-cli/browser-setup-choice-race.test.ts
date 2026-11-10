import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBrowserSetup } from '../../src/npx-cli/install/browser-setup.js';
import { INITIAL_SETUP_STATE, type SetupStateView } from '../../src/shared/setup-state.js';

for (const source of ['browser', 'printed URL'] as const) {
  test(`keeps a choice submitted immediately from the ${source}`, async () => {
    const choice = { branch: 'go' as const, memoryBilling: 'hosted' as const, chosenAt: 'new choice' };
    let state: SetupStateView = {
      ...INITIAL_SETUP_STATE,
      alreadyPro: false,
      choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'previous run' },
    };
    const stages: string[] = [];
    const applied: unknown[] = [];
    let opened = 0;
    const select = () => { state = { ...state, choice }; };
    const outcome = await runBrowserSetup({
      workerBaseUrl: 'http://worker',
      openBrowser: () => { opened++; if (source === 'browser') select(); },
      log: {
        info: message => { if (source === 'printed URL' && message.startsWith('Continue setup in your browser:')) select(); },
        warn: () => {},
      },
      // The setup endpoint clears a prior choice on waiting-for-choice. A fast page
      // submission must happen after that reset, not be erased by it.
      fetch: (async (_url, init) => {
        if (init?.method === 'POST') {
          const { stage } = JSON.parse(String(init.body));
          stages.push(stage);
          if (stage === 'waiting-for-choice') state = { ...state, choice: null };
          else state = { ...state, status: 'complete' };
        }
        return Response.json(state);
      }) as typeof fetch,
      sleep: async () => { throw new Error('The submitted choice was cleared; setup is waiting for another click.'); },
      applyChoice: async selected => { applied.push(selected); return 'go-kept-existing-pro'; },
    });
    assert.equal(opened, 1);
    assert.deepEqual(applied, [choice]);
    assert.deepEqual(stages, ['waiting-for-choice', 'go-kept-existing-pro']);
    assert.equal(outcome.state.status, 'complete');
  });
}

test('still waits for a person who chooses after the page opens', async () => {
  let state: SetupStateView = { ...INITIAL_SETUP_STATE, alreadyPro: false };
  let opened = false;
  let waits = 0;
  const outcome = await runBrowserSetup({
    workerBaseUrl: 'http://worker',
    openBrowser: () => { opened = true; },
    log: { info: () => {}, warn: () => {} },
    fetch: (async (_url, init) => {
      if (init?.method === 'POST' && JSON.parse(String(init.body)).stage === 'home-ready') {
        state = { ...state, status: 'complete' };
      }
      return Response.json(state);
    }) as typeof fetch,
    sleep: async () => {
      assert.equal(opened, true);
      if (++waits === 3) state = { ...state, choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'later' } };
    },
    applyChoice: async () => 'home-ready',
  });
  assert.equal(waits, 3);
  assert.equal(outcome.choice.branch, 'home');
});
