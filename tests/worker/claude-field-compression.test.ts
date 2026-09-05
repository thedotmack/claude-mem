import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as envModule from '../../src/shared/EnvManager.js';
import * as sdkModule from '@anthropic-ai/claude-agent-sdk';
import { getQuotaCooldown, recordQuotaExhausted, resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';
import { optimizeObservationFields } from '../../src/services/worker/field-optimizer.js';

const realEnv = { ...envModule };
const realSdk = { ...sdkModule };
let captured: AbortController | undefined;
let response = 'condensed payload';
let assistantError: string | undefined;
let resultErrors: string[] | undefined;
let successResult: { is_error: boolean; result: string; api_error_status?: number | null } | undefined;
let pending = false;
const calls = mock(() => {});
mock.module('../../src/shared/EnvManager.js', () => ({ ...realEnv,
  buildIsolatedEnvWithFreshOAuth: async () => ({}), getAuthMethodDescription: () => 'api_key',
}));
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...realSdk,
  query: (args: any) => {
    calls();
    captured = args.options.abortController;
    return (async function* () {
      if (pending) {
        await new Promise((_, reject) => {
          captured!.signal.addEventListener('abort', () => reject(captured!.signal.reason), { once: true });
        });
      }
      yield { type: 'assistant', error: assistantError, message: { content: [{ type: 'text', text: response }] } };
      if (resultErrors) yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: resultErrors };
      if (successResult) yield { type: 'result', subtype: 'success', ...successResult };
    })();
  },
}));
const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');
afterAll(() => {
  mock.module('../../src/shared/EnvManager.js', () => realEnv);
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
  resetQuotaCooldownsForTesting();
});
beforeEach(() => {
  captured = undefined;
  pending = false;
  response = 'condensed payload';
  assistantError = undefined;
  resultErrors = undefined;
  successResult = undefined;
  calls.mockClear();
  resetQuotaCooldownsForTesting();
});

describe('Claude auxiliary compression transport', () => {
  function fixture() {
    const session = { sessionDbId: 811, contentSessionId: 'fixture', project: 'fixture', abortController: new AbortController() };
    const provider = new ClaudeProvider(null as any, null as any) as any;
    return { session, compress: (text: string, budget: number, signal: AbortSignal) =>
      provider.compressField(text, budget, session, 'fixture', '/nonexistent/fixture', signal) };
  }

  it('cancels the actual auxiliary SDK controller on optimizer timeout without aborting the session', async () => {
    const { session, compress } = fixture();
    pending = true;
    await expect(optimizeObservationFields({ toolInput: 'x'.repeat(17000), toolOutput: '' },
      (text, budget, { signal }) => compress(text, budget, signal), { sessionDbId: 811 }, undefined,
      { signal: session.abortController.signal, timeoutMs: 15 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(captured?.signal.aborted).toBe(true);
    expect(session.abortController.signal.aborted).toBe(false);
  });

  it('does not spawn auxiliary work during quota cooldown', async () => {
    const { session, compress } = fixture();
    recordQuotaExhausted('claude', 'fixture quota');
    await expect(compress('payload', 1000, session.abortController.signal)).rejects.toMatchObject({ kind: 'quota_paused' });
    expect(calls).not.toHaveBeenCalled();
  });

  it('propagates structured auxiliary billing failure and withholds the second field', async () => {
    const { session, compress } = fixture();
    response = "You've hit your session limit. Please try again later.";
    assistantError = 'billing_error';
    await expect(optimizeObservationFields({ toolInput: 'x'.repeat(17000), toolOutput: 'y'.repeat(17000) },
      (text, budget, { signal }) => compress(text, budget, signal), { sessionDbId: 811 }, undefined,
      { signal: session.abortController.signal })).rejects.toMatchObject({ kind: 'quota_exhausted' });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(getQuotaCooldown('claude')).not.toBeNull();
  });

  for (const text of [
    'The application session limit is now configurable. Tests confirm that the new setting is enforced.',
    'The application showed authentication failed until its session refresh logic was fixed.',
  ]) {
    it(`accepts successful condensation: ${text}`, async () => {
      const { session, compress } = fixture();
      response = text;
      await expect(compress('application log evidence', 1000, session.abortController.signal)).resolves.toBe(text);
      expect(getQuotaCooldown('claude')).toBeNull();
    });
  }

  it('preserves structured auth and rate-limit error kinds without classifying successful text', async () => {
    const { session, compress } = fixture();
    assistantError = 'authentication_failed';
    await expect(compress('payload', 1000, session.abortController.signal)).rejects.toMatchObject({ kind: 'auth_invalid' });
    assistantError = 'rate_limit';
    await expect(compress('payload', 1000, session.abortController.signal)).rejects.toMatchObject({ kind: 'rate_limit' });
  });

  it('does not return a partial condensation from an error result', async () => {
    const { session, compress } = fixture();
    resultErrors = ['quota exceeded'];
    await expect(compress('payload', 1000, session.abortController.signal)).rejects.toMatchObject({ kind: 'quota_exhausted' });
    expect(getQuotaCooldown('claude')).not.toBeNull();
  });

  for (const [status, text, kind] of [
    [402, 'quota exceeded', 'quota_exhausted'],
    [401, 'Invalid API key', 'auth_invalid'],
    [402, 'Payment required', 'quota_exhausted'],
    [401, 'Request denied', 'auth_invalid'],
    [429, 'Request denied', 'rate_limit'],
    [400, 'Request denied', 'unrecoverable'],
    [529, 'Request denied', 'transient'],
    [null, 'quota exceeded', 'quota_exhausted'],
    [undefined, 'Invalid API key', 'auth_invalid'],
  ] as const) {
    it(`classifies success-subtype error metadata: ${status} ${text}`, async () => {
      const { session, compress } = fixture();
      successResult = { is_error: true, result: text, api_error_status: status };
      await expect(compress('payload', 1000, session.abortController.signal)).rejects.toMatchObject({ kind, message: text });
      expect(getQuotaCooldown('claude') !== null).toBe(kind === 'quota_exhausted');
      expect(captured?.signal.aborted).toBe(true);
      expect(session.abortController.signal.aborted).toBe(false);
    });
  }

  it('does not classify successful result prose as provider failure', async () => {
    const { session, compress } = fixture();
    response = 'The application reported quota exceeded and Invalid API key before the fix.';
    successResult = { is_error: false, result: response, api_error_status: null };
    await expect(compress('payload', 1000, session.abortController.signal)).resolves.toBe(response);
    expect(getQuotaCooldown('claude')).toBeNull();
  });
});
