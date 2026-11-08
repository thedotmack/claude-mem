import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { CodexProvider } from '../../src/services/worker/CodexProvider.js';
import {
  recordAuthCooldown,
  recordQuotaExhausted,
  resetQuotaCooldownsForTesting,
  tryAdmitQuotaProbe,
} from '../../src/shared/quota-cooldown.js';

// #5438: after `codex login`, an idle app-server child still holds the old
// OAuth token in memory. The auth recovery probe must recycle the idle
// children before it is dispatched, or it fails on the stale token and
// re-arms the breaker. Only that probe recycles; other dispatches reuse
// warm children.

const PAST_ANY_WINDOW_MS = Date.now() + 365 * 24 * 60 * 60 * 1000;
const STOP_AFTER_ADMISSION = new Error('stop after admission');

function providerWithFakePool() {
  const provider = new CodexProvider(null as any, null as any) as any;
  const calls: string[] = [];
  provider.appServer = {
    recycleIdle: async () => { calls.push('recycleIdle'); },
    withClient: async () => { calls.push('withClient'); throw STOP_AFTER_ADMISSION; },
    close: async () => {},
  };
  return { provider, calls };
}

async function dispatch(provider: any): Promise<void> {
  const config = { apiKey: 'native', model: '', reasoningEffort: null, codexPath: 'codex' };
  await expect(provider.query([{ role: 'user', content: 'observe' }], config)).rejects.toBe(STOP_AFTER_ADMISSION);
}

let savedProvider: string | undefined;
beforeEach(() => {
  savedProvider = process.env.CLAUDE_MEM_PROVIDER;
  process.env.CLAUDE_MEM_PROVIDER = 'codex';
  resetQuotaCooldownsForTesting();
});
afterEach(() => {
  resetQuotaCooldownsForTesting();
  if (savedProvider === undefined) delete process.env.CLAUDE_MEM_PROVIDER;
  else process.env.CLAUDE_MEM_PROVIDER = savedProvider;
});

describe('Codex auth recovery probe recycles idle app-server children', () => {
  it('recycles before dispatching the probe that follows an auth cooldown', async () => {
    recordAuthCooldown('codex', 'Codex: not logged in');
    expect(tryAdmitQuotaProbe('codex', PAST_ANY_WINDOW_MS).claimId).not.toBeNull();
    const { provider, calls } = providerWithFakePool();
    await dispatch(provider);
    expect(calls).toEqual(['recycleIdle', 'withClient']);
  });

  it('does not recycle for a quota cooldown probe', async () => {
    recordQuotaExhausted('codex', 'Codex: usage limit reached');
    expect(tryAdmitQuotaProbe('codex', PAST_ANY_WINDOW_MS).claimId).not.toBeNull();
    const { provider, calls } = providerWithFakePool();
    await dispatch(provider);
    expect(calls).toEqual(['withClient']);
  });

  it('does not recycle while an auth cooldown has no probe claimed', async () => {
    recordAuthCooldown('codex', 'Codex: not logged in');
    const { provider, calls } = providerWithFakePool();
    await dispatch(provider);
    expect(calls).toEqual(['withClient']);
  });

  it('does not recycle with no cooldown armed', async () => {
    const { provider, calls } = providerWithFakePool();
    await dispatch(provider);
    expect(calls).toEqual(['withClient']);
  });
});
