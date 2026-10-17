import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { CodexProvider, classifyCodexError } from '../../src/services/worker/CodexProvider.js';
import { CODEX_ISOLATION_UNATTESTED_CODE } from '../../src/services/worker/CodexAppServerClient.js';
import { resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';
import { clearDependencyStatus, getDependencyStatus } from '../../src/shared/dependency-health.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { logger } from '../../src/utils/logger.js';

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
    ['parameters the app-server cannot take (RPC -32602)',
      new Error('Codex app-server RPC error -32602: Invalid params: missing field `threadId`'), /CLAUDE_MEM_CODEX_REASONING_EFFORT/],
    ['a request the app-server cannot take (RPC -32600)',
      new Error('Codex app-server RPC error -32600: Invalid request'), /update the Codex CLI/i],
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

// JSON-RPC -32603 (internal error) and -32700 (parse error) are the
// app-server's own faults, not a refusal of the request. Held behind the
// codex_cli gate as setup, they paused capture and told the user to check
// settings that were never wrong.
describe('an app-server fault of its own is transient, never setup', () => {
  const cases: Array<[string, Error]> = [
    ['an internal error (RPC -32603)', new Error('Codex app-server RPC error -32603: Internal error')],
    ['an internal error quoting a parser (RPC -32603)', new Error('Codex app-server RPC error -32603: failed to load rollout: unknown variant `foo`')],
    // Quoted account words must not arm the breaker for a fault of the app-server.
    ['an internal error quoting a usage limit (RPC -32603)', new Error('Codex app-server RPC error -32603: failed to refresh usage limit snapshot')],
    ['an internal error quoting a login (RPC -32603)', new Error('Codex app-server RPC error -32603: auth store unavailable: not logged in')],
    ['a parse error (RPC -32700)', new Error('Codex app-server RPC error -32700: Parse error')],
  ];
  for (const [name, error] of cases) {
    it(name, () => {
      const classified = classifyCodexError(error);
      expect(classified.kind).toBe('transient');
      expect(classified.action).toBeUndefined();
    });
  }
});

// A transient Codex failure resumes on the transport backoff with no cap, so
// an app-server that keeps failing internally must say so where it is seen.
describe('a repeated app-server internal error is logged at WARN', () => {
  it('warns from the second internal error in a row for a session, until that session is served', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const failing = new Set<number>([1]);
    provider.runTurnWithRetry = async (_prompt: string, config: { sessionDbId?: number }) => {
      if (failing.has(config.sessionDbId ?? -1)) {
        throw classifyCodexError(new Error('Codex app-server RPC error -32603: Internal error'));
      }
      return { content: '<skip_summary />' };
    };
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    const repeatedWarnings = () => warn.mock.calls
      .filter(([, message]) => String(message).includes('keeps failing with an internal error')).length;
    const ask = (sessionDbId: number) => provider.query([{ role: 'user', content: 'observe' }],
      { apiKey: 'native', model: '', reasoningEffort: null, codexPath: 'codex', sessionDbId });
    try {
      await expect(ask(1)).rejects.toMatchObject({ kind: 'transient' });
      expect(repeatedWarnings()).toBe(0);
      await expect(ask(1)).rejects.toMatchObject({ kind: 'transient' });
      expect(repeatedWarnings()).toBe(1);

      // Another session's served request does not hide this one's failures.
      await ask(2);
      await expect(ask(1)).rejects.toMatchObject({ kind: 'transient' });
      expect(repeatedWarnings()).toBe(2);

      failing.delete(1);
      await ask(1); // served: this session's run of internal errors is over
      failing.add(1);
      await expect(ask(1)).rejects.toMatchObject({ kind: 'transient' });
      expect(repeatedWarnings()).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });
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
