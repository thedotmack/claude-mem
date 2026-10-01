import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { CodexProvider, classifyCodexError } from '../../src/services/worker/CodexProvider.js';
import { CODEX_ISOLATION_UNATTESTED_CODE } from '../../src/services/worker/CodexAppServerClient.js';
import { resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';
import { clearDependencyStatus, getDependencyStatus } from '../../src/shared/dependency-health.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

// R4-3 (#3882): classifyCodexError read every failure it did not recognize as
// 'transient'. A request Codex refuses the same way every time (an effort or
// model it does not serve, a CLI too old for the protocol, an isolation it
// cannot attest) was retried in place, paused as transport:transient, resumed
// on the uncapped transport backoff, and never reached observer-health.

let savedProvider: string | undefined;
beforeEach(() => {
  savedProvider = process.env.CLAUDE_MEM_PROVIDER;
  process.env.CLAUDE_MEM_PROVIDER = 'codex';
  resetQuotaCooldownsForTesting();
  clearDependencyStatus('codex_cli');
});
afterEach(() => {
  resetQuotaCooldownsForTesting();
  clearDependencyStatus('codex_cli');
  if (savedProvider === undefined) delete process.env.CLAUDE_MEM_PROVIDER;
  else process.env.CLAUDE_MEM_PROVIDER = savedProvider;
});

function withInfo(message: string, codexErrorInfo: unknown): Error {
  return Object.assign(new Error(message), { codexErrorInfo });
}

describe('a request Codex refuses the same way every time is setup, not a blip', () => {
  const cases: Array<[string, Error, RegExp]> = [
    ['an effort an older app-server rejects (RPC -32602)',
      new Error('Codex app-server RPC error -32602: Invalid request: unknown variant `max`, expected one of `minimal`, `low`, `medium`, `high`'),
      /CLAUDE_MEM_CODEX_REASONING_EFFORT/],
    ['a method an older CLI lacks (RPC -32601)',
      new Error('Codex app-server RPC error -32601: Method not found'), /update the Codex CLI/i],
    ['a flag an older CLI rejects',
      new Error("Codex app-server exited with code 2 signal null: error: unexpected argument '--strict-config' found"), /update the Codex CLI/i],
    ['a subcommand an older CLI lacks',
      new Error("Codex app-server exited with code 2 signal null: error: unrecognized subcommand 'app-server'"), /update the Codex CLI/i],
    ['a model the plan does not serve (badRequest)',
      withInfo("Codex app-server turn failed: The 'gpt-x' model is not supported when using Codex with a ChatGPT account.", 'badRequest'),
      /CLAUDE_MEM_CODEX_MODEL/],
    ['an effort the API refuses (HTTP 400)',
      withInfo("Codex app-server turn failed: Invalid value: 'bogus'. Supported values are: 'low', 'medium', and 'high'.", { httpConnectionFailed: { httpStatusCode: 400 } }),
      /CLAUDE_MEM_CODEX_REASONING_EFFORT/],
    ['a model the API does not know (HTTP 404)',
      withInfo('Codex app-server turn failed: The model `gpt-x` does not exist', { responseStreamConnectionFailed: { httpStatusCode: 404 } }),
      /CLAUDE_MEM_CODEX_MODEL/],
    ['instruction sources the observer cannot switch off',
      Object.assign(new Error('Codex app-server loaded unexpected instruction sources: /etc/codex/AGENTS.md'), { code: CODEX_ISOLATION_UNATTESTED_CODE }),
      /Codex configuration/],
    ['an MCP server the observer cannot switch off',
      Object.assign(new Error('Codex app-server MCP server corp-mcp is not fully disabled'), { code: CODEX_ISOLATION_UNATTESTED_CODE }),
      /Codex configuration/],
  ];
  for (const [name, error, remedy] of cases) {
    it(name, () => {
      const classified = classifyCodexError(error);
      expect(classified.kind).toBe('setup_required');
      // The remedy rides with the error into observer-health and dependency health.
      expect(classified.action).toMatch(remedy);
    });
  }
});

describe('a refusal of one request content drops that batch, not every later one', () => {
  for (const info of ['cyberPolicy', 'misalignmentPolicyViolation']) {
    it(info, () => {
      expect(classifyCodexError(withInfo('Codex app-server turn failed: refused', info)).kind).toBe('unrecoverable');
    });
  }
});

describe('faults that clear on their own stay transient', () => {
  const cases: Array<[string, Error]> = [
    ['a 5xx', withInfo('Codex app-server turn failed: upstream error', { httpConnectionFailed: { httpStatusCode: 502 } })],
    ['a request timeout (HTTP 408)', withInfo('Codex app-server turn failed: timed out', { httpConnectionFailed: { httpStatusCode: 408 } })],
    ['an overloaded server', withInfo('Codex app-server turn failed: overloaded', 'serverOverloaded')],
    ['an internal server error', withInfo('Codex app-server turn failed: oops', 'internalServerError')],
    ['a dropped stream', withInfo('Codex app-server turn failed: closed', { responseStreamDisconnected: { httpStatusCode: null } })],
    ['an app-server that went away', new Error('Codex app-server exited with code null signal SIGKILL: ')],
  ];
  for (const [name, error] of cases) {
    it(name, () => {
      expect(classifyCodexError(error).kind).toBe('transient');
    });
  }
});

describe('an effort Codex refuses is neither retried in place nor paused as a transport fault', () => {
  it('fails once as setup_required, publishes the codex_cli gate, and leaves the pause to the setup path', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    let turnStarts = 0;
    for (const client of provider.appServer.clients) {
      client.ensureStarted = async () => {};
      client.workspace = 'w';
      client.readInheritedMcpServerNames = async () => [];
      client.attestMcpServersDisabled = async () => {};
      client.request = async (method: string) => {
        if (method === 'thread/start') return { thread: { id: 't' }, instructionSources: [] };
        if (method === 'turn/start') {
          turnStarts += 1;
          throw new Error('Codex app-server RPC error -32602: Invalid request: unknown variant `max`');
        }
        return {};
      };
    }
    const config = { apiKey: 'native', model: '', reasoningEffort: 'max', codexPath: 'codex' };
    let thrown: any;
    try {
      await provider.query([{ role: 'user', content: 'observe' }], config);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.kind).toBe('setup_required');
    expect(turnStarts).toBe(1);
    // Armed before the app-server queue moves on, with the remedy for this cause.
    expect(getDependencyStatus('codex_cli')?.remediation).toContain('CLAUDE_MEM_CODEX_REASONING_EFFORT');

    const session = { sessionDbId: 1, abortController: new AbortController(), cumulativeInputTokens: 0, cumulativeOutputTokens: 0 } as unknown as ActiveSession;
    expect(() => provider.handleSessionError(thrown, session)).toThrow();
    expect(session.abortReason).toBeUndefined();
    expect(session.abortController.signal.aborted).toBe(false);
  });
});
