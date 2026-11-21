import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run the production KnowledgeAgent and CorpusStore in isolation. Only the
// external SDK protocol and executable/OAuth discovery are replaced; no Claude
// process or host credentials are used.
const fixture = String.raw`
  import { mock } from 'bun:test';

  let scenario = '';
  let sdkCalls = [];

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sdkQuery({ options }) {
    const callRecord = {
      resume: options.resume ?? null,
      hasAbortController: Boolean(options.abortController),
      aborted: false,
      returned: false,
    };
    options.abortController?.signal.addEventListener('abort', () => {
      callRecord.aborted = true;
    }, { once: true });
    sdkCalls.push(callRecord);

    const iterator = (async function* () {
      try {
        if (scenario === 'query-stall' || scenario === 'prime-stall' || scenario === 'caller-abort-stall') {
          await new Promise(() => {});
        }
        if (scenario === 'query-active-past-idle') {
          // Yields messages every 25ms (under 70ms idle bound), spanning > 100ms total.
          yield { type: 'system', subtype: 'init', session_id: 'active-session' };
          await sleep(25);
          yield { type: 'system', subtype: 'status', session_id: 'active-session' };
          await sleep(25);
          yield { type: 'system', subtype: 'status', session_id: 'active-session' };
          await sleep(25);
          yield { type: 'system', subtype: 'status', session_id: 'active-session' };
          await sleep(25);
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Paris' }] } };
          yield { type: 'result', subtype: 'success', is_error: false, session_id: 'active-session', result: 'done' };
          return;
        }
        if (scenario === 'query-chatty-past-cap') {
          // Keeps yielding every 20ms so the 70ms idle watchdog keeps resetting,
          // testing that the 140ms absolute cap still terminates the call.
          while (true) {
            yield { type: 'system', subtype: 'status', session_id: 'old-session' };
            await sleep(20);
          }
        }
        if (scenario === 'reprime-stall') {
          if (options.resume === 'old-session') {
            yield {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              errors: ['No conversation found with session ID: old-session'],
            };
            return;
          }
          // Auto-reprime hangs forever.
          await new Promise(() => {});
        }
        if (scenario === 'reprime-retry-stall') {
          if (options.resume === 'old-session') {
            yield {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              errors: ['No conversation found with session ID: old-session'],
            };
            return;
          }
          if (!options.resume) {
            yield { type: 'system', subtype: 'init', session_id: 'primed-session' };
            yield { type: 'result', subtype: 'success', is_error: false, session_id: 'primed-session', result: 'done' };
            return;
          }
          // Retried query hangs forever.
          await new Promise(() => {});
        }
      } finally {
        callRecord.returned = true;
      }
    })();

    return iterator;
  }

  mock.module('@anthropic-ai/claude-agent-sdk', () => ({ query: sdkQuery }));
  mock.module('./src/shared/EnvManager.ts', () => ({
    buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: process.env.PATH }),
  }));
  mock.module('./src/shared/find-claude-executable.ts', () => ({
    findClaudeExecutable: () => '/fixture/claude',
    isClaudeExecutableUnspawnable: () => false,
  }));

  const { KnowledgeAgent } = await import('./src/services/worker/knowledge/KnowledgeAgent.ts');
  const { CorpusStore } = await import('./src/services/worker/knowledge/CorpusStore.ts');
  const store = new CorpusStore();
  const agent = new KnowledgeAgent(store, {
    streamIdleTimeoutMs: 70,
    absoluteCapMs: 160,
  });

  const scenarios = [
    'query-stall',
    'prime-stall',
    'query-active-past-idle',
    'query-chatty-past-cap',
    'reprime-stall',
    'reprime-retry-stall',
    'caller-abort-stall',
  ];

  const outcomes = [];
  for (scenario of scenarios) {
    sdkCalls = [];
    const corpus = {
      version: 1,
      name: scenario,
      description: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      filter: {},
      stats: { observation_count: 0, token_estimate: 0, date_range: { earliest: '', latest: '' }, type_breakdown: {} },
      system_prompt: 'Use only this corpus',
      session_id: scenario === 'prime-stall' ? null : 'old-session',
      observations: [],
    };
    store.write(corpus);

    const callerController = new AbortController();
    const callerReason = new Error('caller hung up');
    if (scenario === 'caller-abort-stall') {
      setTimeout(() => callerController.abort(callerReason), 25);
    }

    const startedAt = Date.now();
    let settled = false;
    let result;
    let errorMessage;
    let errorStatus;
    let errorCode;
    let matchedCallerReason = false;

    const callPromise = scenario === 'prime-stall'
      ? agent.prime(corpus, { abortController: callerController })
      : agent.query(corpus, 'question', { abortController: callerController });

    const guard = new Promise((resolve) => setTimeout(() => resolve('TIMED_OUT_IN_TEST'), 600));
    const race = await Promise.race([
      callPromise.then(
        (val) => { settled = true; result = val; return 'OK'; },
        (err) => {
          settled = true;
          errorMessage = err instanceof Error ? err.message : String(err);
          errorStatus = err?.statusCode;
          errorCode = err?.code;
          matchedCallerReason = err === callerReason;
          return 'ERR';
        },
      ),
      guard,
    ]);

    const elapsedMs = Date.now() - startedAt;
    outcomes.push({
      scenario,
      race,
      settled,
      elapsedMs,
      result,
      errorMessage,
      errorStatus,
      errorCode,
      matchedCallerReason,
      callerAborted: callerController.signal.aborted,
      memorySession: corpus.session_id,
      diskSession: store.read(corpus.name).session_id,
      sdkCalls,
    });
  }

  console.log(JSON.stringify(outcomes));
  process.exit(0);
`;

interface SdkCallRecord {
  resume: string | null;
  hasAbortController: boolean;
  aborted: boolean;
  returned: boolean;
}

interface Outcome {
  scenario: string;
  race: string;
  settled: boolean;
  elapsedMs: number;
  result?: { answer: string; session_id: string };
  errorMessage?: string;
  errorStatus?: number;
  errorCode?: string;
  matchedCallerReason: boolean;
  callerAborted: boolean;
  memorySession: string | null;
  diskSession: string | null;
  sdkCalls: SdkCallRecord[];
}

describe('knowledge query and prime deadlines', () => {
  let outcomes: Outcome[] = [];
  const outcomeFor = (scenario: string) => outcomes.find((entry) => entry.scenario === scenario)!;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-query-deadline-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      outcomes = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails a stalled query within the idle bound with 504 and aborts the SDK controller', () => {
    const outcome = outcomeFor('query-stall');
    expect(outcome.settled).toBe(true);
    expect(outcome.race).toBe('ERR');
    expect(outcome.errorStatus).toBe(504);
    expect(outcome.errorCode).toBe('KNOWLEDGE_QUERY_TIMEOUT');
    expect(outcome.callerAborted).toBe(false);
    expect(outcome.sdkCalls).toHaveLength(1);
    expect(outcome.sdkCalls[0].hasAbortController).toBe(true);
    expect(outcome.sdkCalls[0].aborted).toBe(true);
    expect(outcome.memorySession).toBe('old-session');
    expect(outcome.diskSession).toBe('old-session');
  });

  it('fails a stalled prime within the idle bound with 504 and aborts the SDK controller', () => {
    const outcome = outcomeFor('prime-stall');
    expect(outcome.settled).toBe(true);
    expect(outcome.race).toBe('ERR');
    expect(outcome.errorStatus).toBe(504);
    expect(outcome.errorCode).toBe('KNOWLEDGE_PRIME_TIMEOUT');
    expect(outcome.callerAborted).toBe(false);
    expect(outcome.sdkCalls).toHaveLength(1);
    expect(outcome.sdkCalls[0].hasAbortController).toBe(true);
    expect(outcome.sdkCalls[0].aborted).toBe(true);
    expect(outcome.memorySession).toBeNull();
    expect(outcome.diskSession).toBeNull();
  });

  it('resets the idle watchdog on each SDK message so an active stream succeeds past the idle window', () => {
    const outcome = outcomeFor('query-active-past-idle');
    expect(outcome.settled).toBe(true);
    expect(outcome.race).toBe('OK');
    expect(outcome.result).toEqual({ answer: 'Paris', session_id: 'active-session' });
    expect(outcome.sdkCalls[0].aborted).toBe(false);
    expect(outcome.diskSession).toBe('active-session');
  });

  it('enforces the absolute cap on a chatty stream that never finishes', () => {
    const outcome = outcomeFor('query-chatty-past-cap');
    expect(outcome.settled).toBe(true);
    expect(outcome.race).toBe('ERR');
    expect(outcome.errorStatus).toBe(504);
    expect(outcome.errorCode).toBe('KNOWLEDGE_QUERY_TIMEOUT');
    expect(outcome.callerAborted).toBe(false);
    expect(outcome.sdkCalls).toHaveLength(1);
    expect(outcome.sdkCalls[0].aborted).toBe(true);
  });

  it('bounds the auto-reprime step when a resumed session is missing', () => {
    const outcome = outcomeFor('reprime-stall');
    expect(outcome.settled).toBe(true);
    expect(outcome.race).toBe('ERR');
    expect(outcome.errorStatus).toBe(504);
    expect(outcome.errorCode).toBe('KNOWLEDGE_PRIME_TIMEOUT');
    expect(outcome.sdkCalls.map((c) => c.resume)).toEqual(['old-session', null]);
    expect(outcome.sdkCalls[1].aborted).toBe(true);
  });

  it('bounds the retried query after auto-reprime and preserves the primed session', () => {
    const outcome = outcomeFor('reprime-retry-stall');
    expect(outcome.settled).toBe(true);
    expect(outcome.race).toBe('ERR');
    expect(outcome.errorStatus).toBe(504);
    expect(outcome.errorCode).toBe('KNOWLEDGE_QUERY_TIMEOUT');
    expect(outcome.sdkCalls.map((c) => c.resume)).toEqual(['old-session', null, 'primed-session']);
    expect(outcome.sdkCalls[2].aborted).toBe(true);
    expect(outcome.diskSession).toBe('primed-session');
  });

  it('propagates caller abort to the SDK controller and settles even when the stream ignores abort', () => {
    const outcome = outcomeFor('caller-abort-stall');
    expect(outcome.settled).toBe(true);
    expect(outcome.race).toBe('ERR');
    expect(outcome.matchedCallerReason).toBe(true);
    expect(outcome.callerAborted).toBe(true);
    expect(outcome.sdkCalls).toHaveLength(1);
    expect(outcome.sdkCalls[0].aborted).toBe(true);
  });
});
