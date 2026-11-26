// #6503: the Claude provider's condense ask was sized by
// CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS (#6508), but replies ran ~3x the ask
// and nothing bounded them. The Agent SDK has no per-request output cap, so
// the condense call hands the cap to the Claude Code child as
// CLAUDE_CODE_MAX_OUTPUT_TOKENS, and a reply that stopped at the cap counts
// as truncated so the field falls back to the head/tail cut. Other callers of
// runStandaloneObserverPrompt (the Telegram wrap-up) must stay uncapped.
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

// No SDK process, OAuth refresh, or paid request may run in this harness.
const actualSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
const actualFindClaude = { ...(await import('../../src/shared/find-claude-executable.js')) };
const actualEnv = { ...(await import('../../src/shared/EnvManager.js')) };

// Captured from Claude Code with CLAUDE_CODE_MAX_OUTPUT_TOKENS=64: the CLI
// drops the cut reply, writes a '<synthetic>' assistant notice, and ends the
// turn as an error naming the cap, with stop_reason 'stop_sequence'.
const CAP_NOTICE = "API Error: Claude's response exceeded the 64 output token maximum. "
  + 'To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.';

let stopReason: string | null = 'end_turn';
let cliCutAtCap = false;
const sdkQuery = mock((_input: unknown) => (async function* () {
  if (cliCutAtCap) {
    yield { type: 'assistant', message: { model: 'claude-opus-5-5', content: [], stop_reason: null } };
    yield { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: CAP_NOTICE }], stop_reason: 'stop_sequence' } };
    yield { type: 'result', subtype: 'success', is_error: true, result: CAP_NOTICE, stop_reason: 'stop_sequence' };
    return;
  }
  yield { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'condensed reply' }], stop_reason: null } };
  yield { type: 'result', subtype: 'success', is_error: false, result: 'condensed reply', stop_reason: stopReason };
})());

mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...actualSdk, query: sdkQuery }));
mock.module('../../src/shared/find-claude-executable.js', () => ({
  ...actualFindClaude, findClaudeExecutable: () => '/mock/claude',
}));
// A host-level cap must never leak through: sanitizeEnv strips it, and only
// the condense call sets its own.
mock.module('../../src/shared/EnvManager.js', () => ({
  ...actualEnv,
  buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: '/mock/bin', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '99999' }),
}));

const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');

let settings: Record<string, string> = SettingsDefaultsManager.getAllDefaults();

function makeSession(): ActiveSession {
  return {
    sessionDbId: 7,
    contentSessionId: 'condense-cap-session',
    project: 'test-project',
    abortController: new AbortController(),
  } as ActiveSession;
}

type Compressor = {
  compressField(
    text: string, budgetChars: number, session: ActiveSession, modelId: string, claudePath: string, signal: AbortSignal,
  ): Promise<{ text: string; truncated: boolean } | null>;
};

function compress(): Promise<{ text: string; truncated: boolean } | null> {
  const provider = new ClaudeProvider({} as never, {} as never) as unknown as Compressor;
  return provider.compressField('x'.repeat(20_000), 6_400, makeSession(), 'haiku', '/mock/claude', new AbortController().signal);
}

function sentEnv(call = 0): Record<string, string | undefined> {
  const { options } = sdkQuery.mock.calls[call][0] as { options: { env: Record<string, string | undefined> } };
  return options.env;
}

beforeEach(() => {
  sdkQuery.mockClear();
  stopReason = 'end_turn';
  cliCutAtCap = false;
  settings = { ...SettingsDefaultsManager.getAllDefaults() };
  spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => settings);
});

afterEach(() => mock.restore());
afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => actualSdk);
  mock.module('../../src/shared/find-claude-executable.js', () => actualFindClaude);
  mock.module('../../src/shared/EnvManager.js', () => actualEnv);
});

describe('Claude condense reply cap (#6503)', () => {
  it('hands the configured cap to the Claude Code child of the condense call', async () => {
    settings.CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS = '3200';
    await compress();
    expect(sdkQuery).toHaveBeenCalledTimes(1);
    expect(sentEnv().CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('3200');
  });

  it('uses the default cap when the setting is unset', async () => {
    await compress();
    expect(sentEnv().CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('4096');
  });

  it('reports a whole reply as not truncated', async () => {
    await expect(compress()).resolves.toEqual({ text: 'condensed reply', truncated: false });
  });

  it('reports a reply stopped at the cap as truncated', async () => {
    stopReason = 'max_tokens';
    await expect(compress()).resolves.toEqual({ text: 'condensed reply', truncated: true });
  });

  it('reports the CLI output-cap error as a cut reply, never as condensed text', async () => {
    cliCutAtCap = true;
    await expect(compress()).resolves.toEqual({ text: '', truncated: true });
  });

  it('still throws on other CLI errors', async () => {
    const original = sdkQuery.getMockImplementation();
    sdkQuery.mockImplementationOnce(() => (async function* () {
      yield { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 overloaded', stop_reason: null };
    })());
    await expect(compress()).rejects.toThrow('529 overloaded');
    expect(sdkQuery.getMockImplementation()).toBe(original);
  });

  it('treats a missing stop reason as whole', async () => {
    stopReason = null;
    await expect(compress()).resolves.toEqual({ text: 'condensed reply', truncated: false });
  });

  it('leaves the Telegram wrap-up call uncapped', async () => {
    const provider = new ClaudeProvider({} as never, {} as never);
    await provider.formatTelegramWrapup({
      sessionDbId: 7,
      contentSessionId: 'condense-cap-session',
      project: 'test-project',
      platformSource: 'claude',
      summaryText: 'summary',
    }, 'haiku');
    expect(sdkQuery).toHaveBeenCalledTimes(1);
    expect(sentEnv().CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
  });

  it('fails the Telegram wrap-up rather than sending the CLI cap notice', async () => {
    cliCutAtCap = true;
    const provider = new ClaudeProvider({} as never, {} as never);
    await expect(provider.formatTelegramWrapup({
      sessionDbId: 7,
      contentSessionId: 'condense-cap-session',
      project: 'test-project',
      platformSource: 'claude',
      summaryText: 'summary',
    }, 'haiku')).rejects.toThrow('no text');
  });

  it('returns the Telegram wrap-up text even when it stopped at max_tokens', async () => {
    stopReason = 'max_tokens';
    const provider = new ClaudeProvider({} as never, {} as never);
    await expect(provider.formatTelegramWrapup({
      sessionDbId: 7,
      contentSessionId: 'condense-cap-session',
      project: 'test-project',
      platformSource: 'claude',
      summaryText: 'summary',
    }, 'haiku')).resolves.toBe('condensed reply');
  });
});
