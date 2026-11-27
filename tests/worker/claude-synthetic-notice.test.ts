// #6503: the Claude Code CLI writes its own notices (an API error, an
// output-cap message) as assistant messages from the '<synthetic>' model.
// runStandaloneObserverPrompt must never take one as model text: not as
// condensed field text, and not as the Telegram wrap-up.
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

// No SDK process, OAuth refresh, or paid request may run in this harness.
const actualSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
const actualFindClaude = { ...(await import('../../src/shared/find-claude-executable.js')) };
const actualEnv = { ...(await import('../../src/shared/EnvManager.js')) };

const NOTICE = 'API Error: Repeated 529 Overloaded errors. Try again later.';

// What the CLI sends for this turn: optional '<synthetic>' notice, then model text (if any).
let withNotice = true;
let modelText = '';
const sdkQuery = mock((_input: unknown) => (async function* () {
  if (withNotice) {
    yield { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: NOTICE }], stop_reason: null } };
  }
  if (modelText) {
    yield { type: 'assistant', message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: modelText }], stop_reason: null } };
  }
  yield { type: 'result', subtype: 'success', is_error: false, result: modelText, stop_reason: 'end_turn' };
})());

mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...actualSdk, query: sdkQuery }));
mock.module('../../src/shared/find-claude-executable.js', () => ({
  ...actualFindClaude, findClaudeExecutable: () => '/mock/claude',
}));
mock.module('../../src/shared/EnvManager.js', () => ({
  ...actualEnv,
  buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: '/mock/bin' }),
}));

const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');

let settings: Record<string, string> = SettingsDefaultsManager.getAllDefaults();

function makeSession(): ActiveSession {
  return {
    sessionDbId: 7,
    contentSessionId: 'synthetic-notice-session',
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

function wrapup(): Promise<string> {
  const provider = new ClaudeProvider({} as never, {} as never);
  return provider.formatTelegramWrapup({
    sessionDbId: 7,
    contentSessionId: 'synthetic-notice-session',
    project: 'test-project',
    platformSource: 'claude',
    summaryText: 'summary',
  }, 'haiku');
}

beforeEach(() => {
  sdkQuery.mockClear();
  withNotice = true;
  modelText = '';
  settings = { ...SettingsDefaultsManager.getAllDefaults() };
  spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => settings);
});

afterEach(() => mock.restore());
afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => actualSdk);
  mock.module('../../src/shared/find-claude-executable.js', () => actualFindClaude);
  mock.module('../../src/shared/EnvManager.js', () => actualEnv);
});

describe("Claude standalone prompt ignores the CLI's <synthetic> notices (#6503)", () => {
  it('keeps a CLI notice out of the condensed field text', async () => {
    modelText = 'condensed reply';
    await expect(compress()).resolves.toEqual({ text: 'condensed reply', truncated: false });
  });

  it('never sends a CLI notice as the Telegram wrap-up', async () => {
    await expect(wrapup()).rejects.toThrow('no text');
  });

  it('still returns model text when no notice comes', async () => {
    withNotice = false;
    modelText = 'wrap-up text';
    await expect(wrapup()).resolves.toBe('wrap-up text');
  });
});
