import { describe, expect, it, mock } from 'bun:test';
import { existsSync, rmSync, statSync } from 'fs';
import {
  buildCodexExecEnv,
  buildCodexExecArgs,
  buildCodexSpawnCommand,
  buildCodexObservationPrompt,
  CodexProvider,
  classifyCodexExecError,
  createCodexExecWorkDir,
  normalizeCodexExecutablePath,
  parseCodexReasoningEffort,
  parseCodexExecJsonl,
  sanitizeCodexObservationResponse,
} from '../../src/services/worker/CodexProvider.js';
import type { ActiveSession, PendingMessage } from '../../src/services/worker-types.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

const modeManager = ModeManager.getInstance() as { loadMode?: (modeId: string) => unknown };
modeManager.loadMode?.('code');

function createProviderFlowSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: 'codex-session-1',
    memorySessionId: 'codex-memory-1',
    project: 'test-project',
    platformSource: 'codex',
    userPrompt: 'Check claude-mem Codex provider',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: Date.now() - 1000,
    claimedMessageIds: [1],
    conversationHistory: [],
    currentProvider: 'codex',
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
    ...overrides,
  };
}

class TestCodexProvider extends CodexProvider {
  private readonly responses: string[];
  readonly queryCalls = mock(() => {});

  constructor(dbManager: never, sessionManager: never, responses: string[]) {
    super(dbManager, sessionManager);
    this.responses = [...responses];
  }

  protected getConfig(): any {
    return {
      apiKey: 'codex-cli-auth',
      model: 'gpt-5.6-luna',
      codexPath: 'codex',
      reasoningEffort: 'low',
      maxContextMessages: 20,
      maxEstimatedTokens: 100000,
      timeoutMs: 120000,
      maxObservationsPerPrompt: 6,
    };
  }

  protected async query(): Promise<any> {
    this.queryCalls();
    return {
      content: this.responses.shift() ?? '',
      tokensUsed: 12,
      inputTokens: 10,
      outputTokens: 2,
      servedModel: 'gpt-5.6-luna',
    };
  }
}

function createProviderFlowHarness(
  message: PendingMessage,
  responses: string[],
  options: { existingObservationCount?: number } = {},
) {
  const storeObservations = mock(() => ({
    observationIds: [101],
    summaryId: null,
    createdAtEpoch: 1700000000000,
  }));
  const confirmClaimedMessages = mock(() => Promise.resolve(1));
  const countObservationsForPrompt = mock(() => options.existingObservationCount ?? 0);

  const dbManager = {
    getSessionStore: () => ({
      storeObservations,
      ensureMemorySessionIdRegistered: mock(() => {}),
      countObservationsForPrompt,
    }),
    getChromaSync: () => ({
      syncObservation: mock(() => Promise.resolve()),
      syncSummary: mock(() => Promise.resolve()),
    }),
    getCloudSync: () => ({ notify: mock(() => {}) }),
  } as never;

  const sessionManager = {
    getMessageIterator: async function* () {
      yield message;
    },
    confirmClaimedMessages,
    getClaimedMessages: mock(() => [message]),
    resetProcessingToPending: mock(() => Promise.resolve(0)),
  } as never;

  return {
    provider: new TestCodexProvider(dbManager, sessionManager, responses),
    storeObservations,
    confirmClaimedMessages,
    countObservationsForPrompt,
  };
}

describe('parseCodexExecJsonl', () => {
  it('extracts the final assistant message and Codex usage from exec JSONL', () => {
    const result = parseCodexExecJsonl([
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item-1',
          type: 'agent_message',
          text: '<observation><type>discovery</type><title>Codex</title><narrative>Captured.</narrative></observation>',
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 3,
          reasoning_output_tokens: 1,
        },
      }),
    ].join('\n'));

    expect(result.content).toContain('<observation>');
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(4);
    expect(result.tokensUsed).toBe(16);
  });

  it('ignores non-JSON progress lines and uses the latest agent message', () => {
    const result = parseCodexExecJsonl([
      'Codex CLI starting...',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'second' } }),
    ].join('\n'));

    expect(result.content).toBe('second');
    expect(result.tokensUsed).toBeUndefined();
  });
});

describe('classifyCodexExecError', () => {
  it('classifies a missing Codex executable as unrecoverable', () => {
    const cause = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    const err = classifyCodexExecError({ cause });

    expect(err.kind).toBe('unrecoverable');
    expect(err.message).toContain('CLAUDE_MEM_CODEX_PATH');
    expect(err.cause).toBe(cause);
  });

  it('classifies login failures as auth_invalid', () => {
    const err = classifyCodexExecError({
      exitCode: 1,
      stderr: 'not logged in; run codex login',
      cause: new Error('codex failed'),
    });

    expect(err.kind).toBe('auth_invalid');
  });

  it('classifies plan usage caps as quota_exhausted', () => {
    const err = classifyCodexExecError({
      exitCode: 1,
      stderr: 'usage limit reached for this plan',
      cause: new Error('codex failed'),
    });

    expect(err.kind).toBe('quota_exhausted');
  });
});

describe('parseCodexReasoningEffort', () => {
  it('accepts supported Codex reasoning effort values', () => {
    expect(parseCodexReasoningEffort('low')).toBe('low');
    expect(parseCodexReasoningEffort(' HIGH ')).toBe('high');
    expect(parseCodexReasoningEffort('minimal')).toBe('minimal');
  });

  it('ignores empty or unsupported values', () => {
    expect(parseCodexReasoningEffort('')).toBeNull();
    expect(parseCodexReasoningEffort('fast')).toBeNull();
  });
});

describe('buildCodexExecArgs', () => {
  it('runs Codex exec as an isolated read-only non-interactive turn', () => {
    const workDir = '/tmp/claude-mem-codex-test';
    const args = buildCodexExecArgs({
      model: 'gpt-5.4-mini',
      reasoningEffort: null,
    }, workDir);

    expect(args).toContain('--json');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('--cd');
    expect(args[args.indexOf('--cd') + 1]).toBe(workDir);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--dangerously-bypass-hook-trust');
  });

  it('passes reasoning effort through a Codex config override', () => {
    const args = buildCodexExecArgs({
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
    }, '/tmp/claude-mem-codex-test');

    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort="low"');
  });

  it('omits the reasoning override when unset', () => {
    const args = buildCodexExecArgs({
      model: 'gpt-5.4-mini',
      reasoningEffort: null,
    }, '/tmp/claude-mem-codex-test');

    expect(args).not.toContain('-c');
    expect(args.some(arg => arg.startsWith('model_reasoning_effort='))).toBe(false);
  });
});

describe('createCodexExecWorkDir', () => {
  it('creates a private temporary workdir for each codex exec attempt', () => {
    const workDir = createCodexExecWorkDir();
    try {
      expect(existsSync(workDir)).toBe(true);
      if (process.platform !== 'win32') {
        expect(statSync(workDir).mode & 0o777).toBe(0o700);
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('normalizeCodexExecutablePath', () => {
  it('defaults blank values to codex', () => {
    expect(normalizeCodexExecutablePath(undefined)).toBe('codex');
    expect(normalizeCodexExecutablePath('   ')).toBe('codex');
  });

  it('rejects Windows shell metacharacters in custom codex paths', () => {
    expect(() => normalizeCodexExecutablePath('codex & calc.exe', 'win32')).toThrow(/unsafe/);
    expect(() => normalizeCodexExecutablePath('codex%COMSPEC%', 'win32')).toThrow(/unsafe/);
    expect(() => normalizeCodexExecutablePath('"C:\\Program Files\\Codex\\codex.cmd"', 'win32')).toThrow(/unsafe/);
  });

  it('allows ordinary Windows executable paths', () => {
    expect(normalizeCodexExecutablePath('C:\\Program Files\\Codex\\codex.cmd', 'win32'))
      .toBe('C:\\Program Files\\Codex\\codex.cmd');
  });
});

describe('buildCodexSpawnCommand', () => {
  it('quotes Windows executable paths with spaces for shell execution', () => {
    expect(buildCodexSpawnCommand('C:\\Program Files\\Codex\\codex.cmd', 'win32'))
      .toBe('"C:\\Program Files\\Codex\\codex.cmd"');
  });

  it('leaves non-Windows executable paths unquoted for direct spawn', () => {
    expect(buildCodexSpawnCommand('/Applications/Codex CLI/codex', 'darwin'))
      .toBe('/Applications/Codex CLI/codex');
  });
});

describe('CodexProvider prompt formatting', () => {
  it('keeps the latest message when it alone exceeds the token budget', () => {
    const provider = new CodexProvider(null as never, null as never) as unknown as {
      formatPrompt(history: Array<{ role: 'user' | 'assistant'; content: string }>, config: unknown): string;
    };
    const oversizedLatestMessage = `latest durable observation ${'x'.repeat(200)}`;

    const prompt = provider.formatPrompt([
      { role: 'assistant', content: 'older context that can be dropped' },
      { role: 'user', content: oversizedLatestMessage },
    ], {
      maxContextMessages: 20,
      maxEstimatedTokens: 1,
    });

    expect(prompt).toContain('--- 1. USER ---');
    expect(prompt).toContain(oversizedLatestMessage);
    expect(prompt).not.toContain('older context that can be dropped');
  });
});

describe('buildCodexExecEnv', () => {
  it('keeps only OS basics and Codex-specific paths for the subprocess', () => {
    const env = buildCodexExecEnv({
      PATH: '/usr/bin',
      HOME: '/home/tester',
      CODEX_HOME: '/home/tester/.codex',
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/local-ca.pem',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      GEMINI_API_KEY: 'gemini-secret',
      OPENROUTER_API_KEY: 'openrouter-secret',
      OPENAI_API_KEY: 'openai-secret',
      HTTPS_PROXY: 'http://proxy.local:8080',
      HTTP_PROXY: 'http://proxy.local:8080',
      NO_PROXY: 'localhost,127.0.0.1',
      CUSTOM_TOKEN: 'custom-secret',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/tester');
    expect(env.CODEX_HOME).toBe('/home/tester/.codex');
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/local-ca.pem');

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    // Proxy variables are intentionally not inherited; Codex runs with an
    // explicit, minimal environment rather than ambient network routing state.
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.CUSTOM_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });
});

describe('buildCodexObservationPrompt', () => {
  it('adds strict anti-fragmentation rules for Codex observation generation', () => {
    const prompt = buildCodexObservationPrompt({
      id: 1,
      tool_name: 'Bash',
      tool_input: JSON.stringify({ cmd: 'git diff --stat' }),
      tool_output: JSON.stringify({ output: 'file.ts | 137 ++++++++++++++++-----------' }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('at most 1 <observation>...</observation> blocks');
    expect(prompt).toContain('Usually emit zero observations');
    expect(prompt).toContain('Do not create observations for routine probes');
    expect(prompt).toContain('Every emitted observation must include a non-empty <narrative>');
    expect(prompt).toContain('Never emit facts-only observations');
    expect(prompt).toContain('Do not split a single command output');
  });
});

describe('sanitizeCodexObservationResponse', () => {
  it('drops facts-only Codex observations and keeps only one substantive block', () => {
    const response = `
<observation>
  <type>discovery</type>
  <title>Working tree was clean</title>
  <facts>
    <fact>git status --short returned no output.</fact>
  </facts>
</observation>
<observation>
  <type>discovery</type>
  <title>Codex provider is active</title>
  <facts>
    <fact>The worker health endpoint reported provider=codex.</fact>
  </facts>
  <narrative>The durable runtime conclusion is that claude-mem is actively using the Codex provider after restart.</narrative>
</observation>
<observation>
  <type>discovery</type>
  <title>Duplicate runtime state</title>
  <facts>
    <fact>The same provider state was checked again.</fact>
  </facts>
  <narrative>This repeats the same runtime conclusion and should be left for a later batch only if it changes.</narrative>
</observation>`;

    const sanitized = sanitizeCodexObservationResponse(response);

    expect(sanitized).toContain('Codex provider is active');
    expect(sanitized).toContain('actively using the Codex provider');
    expect(sanitized).not.toContain('Working tree was clean');
    expect(sanitized).not.toContain('Duplicate runtime state');
    expect(sanitized.match(/<observation>/g)).toHaveLength(1);
  });

  it('returns an empty response when Codex emits only facts-only observations', () => {
    const sanitized = sanitizeCodexObservationResponse(`
<observation>
  <type>bugfix</type>
  <title>Command availability was checked</title>
  <facts>
    <fact>pandoc exists at /usr/bin/pandoc.</fact>
  </facts>
</observation>`);

    expect(sanitized).toBe('');
  });

  it('returns an empty response when Codex emits an untitled observation', () => {
    const sanitized = sanitizeCodexObservationResponse(`
<observation>
  <type>bugfix</type>
  <facts><fact>The failing test named a concrete compatibility error.</fact></facts>
  <narrative>The durable debugging conclusion is useful, but without a title this would render as an anonymous spam card.</narrative>
</observation>`);

    expect(sanitized).toBe('');
  });
});

describe('CodexProvider observation response sanitation', () => {
  it('uses the Codex sanitizer before storing observation output', () => {
    const provider = new CodexProvider(null as never, null as never) as unknown as {
      sanitizeObservationResponseContent(content: string, config: unknown): string;
    };

    const sanitized = provider.sanitizeObservationResponseContent(`
<observation>
  <type>discovery</type>
  <title>Facts only</title>
  <facts><fact>This should be skipped.</fact></facts>
</observation>`, {});

    expect(sanitized).toBe('');
  });

  it('does not store facts-only XML returned by the Codex observation turn', async () => {
    const { provider, storeObservations, confirmClaimedMessages } = createProviderFlowHarness({
      type: 'observation',
      tool_name: 'Bash',
      tool_input: { cmd: 'command -v pandoc || true' },
      tool_response: { output: '/usr/bin/pandoc' },
      prompt_number: 2,
      cwd: '/repo',
    }, [
      '',
      `<observation>
        <type>discovery</type>
        <title>Pandoc availability was checked</title>
        <facts><fact>pandoc exists at /usr/bin/pandoc.</fact></facts>
      </observation>`,
    ]);
    const session = createProviderFlowSession();

    await provider.startSession(session);

    expect(storeObservations).not.toHaveBeenCalled();
    expect(confirmClaimedMessages).toHaveBeenCalledWith(session.sessionDbId);
  });

  it('does not store untitled XML returned by the Codex observation turn', async () => {
    const { provider, storeObservations, confirmClaimedMessages } = createProviderFlowHarness({
      type: 'observation',
      tool_name: 'Bash',
      tool_input: { cmd: 'npm test -- --watchAll=false src/tasks/TaskFeed.test.js' },
      tool_response: { output: 'TypeError: usePermissions is not a function' },
      prompt_number: 2,
      cwd: '/repo',
    }, [
      '',
      `<observation>
        <type>bugfix</type>
        <facts><fact>The test failed with TypeError: usePermissions is not a function.</fact></facts>
        <narrative>The failing test identifies a concrete compatibility problem, but an untitled card should not be stored by the Codex provider.</narrative>
      </observation>`,
    ]);
    const session = createProviderFlowSession();

    await provider.startSession(session);

    expect(storeObservations).not.toHaveBeenCalled();
    expect(confirmClaimedMessages).toHaveBeenCalledWith(session.sessionDbId);
  });

  it('skips Codex observation compression once the prompt budget is exhausted', async () => {
    const { provider, storeObservations, confirmClaimedMessages, countObservationsForPrompt } = createProviderFlowHarness({
      type: 'observation',
      tool_name: 'Bash',
      tool_input: { cmd: 'git diff --stat' },
      tool_response: { output: 'frontend/src/tasks/TaskFeed.js | 20 ++++++++++' },
      prompt_number: 2,
      cwd: '/repo',
    }, [
      '',
      `<observation>
        <type>bugfix</type>
        <title>This should not be requested</title>
        <facts><fact>Budget was already exhausted.</fact></facts>
        <narrative>The provider should not have called Codex for this message.</narrative>
      </observation>`,
    ], { existingObservationCount: 6 });
    const session = createProviderFlowSession();

    await provider.startSession(session);

    expect(countObservationsForPrompt).toHaveBeenCalledWith('codex-memory-1', 2);
    expect(provider.queryCalls).toHaveBeenCalledTimes(1);
    expect(storeObservations).not.toHaveBeenCalled();
    expect(confirmClaimedMessages).toHaveBeenCalledWith(session.sessionDbId);
  });

  it('stores only the first substantive Codex observation from a noisy response', async () => {
    const { provider, storeObservations } = createProviderFlowHarness({
      type: 'observation',
      tool_name: 'Bash',
      tool_input: { cmd: 'curl -fsS http://127.0.0.1:37700/api/health' },
      tool_response: { output: '{"status":"ok","ai":{"provider":"codex"}}' },
      prompt_number: 2,
      cwd: '/repo',
    }, [
      '',
      `<observation>
        <type>discovery</type>
        <title>Worker health was checked</title>
        <facts><fact>The health endpoint returned ok.</fact></facts>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Codex provider is active</title>
        <facts><fact>The worker health payload reported ai.provider=codex.</fact></facts>
        <narrative>The durable runtime conclusion is that claude-mem compression is currently routed through the Codex provider.</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Duplicate Codex provider check</title>
        <facts><fact>The same health payload was inspected twice.</fact></facts>
        <narrative>This repeats the provider conclusion and should not produce another memory card.</narrative>
      </observation>`,
    ]);
    const session = createProviderFlowSession();

    await provider.startSession(session);

    expect(storeObservations).toHaveBeenCalledTimes(1);
    const [, , observations] = storeObservations.mock.calls[0];
    expect(observations).toHaveLength(1);
    expect(observations[0].title).toBe('Codex provider is active');
    expect(observations[0].narrative).toContain('compression is currently routed through the Codex provider');
  });
});
