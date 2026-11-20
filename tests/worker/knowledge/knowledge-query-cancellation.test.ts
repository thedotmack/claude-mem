import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run the production agent and file store in isolation. Only the external SDK
// protocol and executable/OAuth discovery are replaced; no Claude process or
// host credentials are used.
const fixture = String.raw`
  import { mock } from 'bun:test';
  let scenario = '';
  let sdkCalls = [];
  let controller;
  const aborted = new Error('caller disconnected');
  function sdkQuery({ options }) {
    sdkCalls.push(options.resume ?? null);
    return (async function* () {
      if (scenario.includes('reprime') && options.resume === 'old-session') {
        yield { type: 'result', subtype: 'error_during_execution', is_error: true,
          errors: ['No conversation found with session ID: old-session'] };
        return;
      }
      const session_id = options.resume ? 'answer-session' : 'primed-session';
      yield { type: 'system', subtype: 'init', session_id };
      if (options.resume) yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Complete answer' }] } };
      yield { type: 'result', subtype: 'success', is_error: false, session_id, result: 'done' };
      // A cancelled SDK stream can finish normally instead of throwing.
      if (scenario.includes('abort') && (options.resume || scenario === 'prime-abort')) controller.abort(aborted);
    })();
  }
  mock.module('@anthropic-ai/claude-agent-sdk', () => ({ query: sdkQuery }));
  mock.module('./src/shared/EnvManager.ts', () => ({ buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: process.env.PATH }) }));
  mock.module('./src/shared/find-claude-executable.ts', () => ({ findClaudeExecutable: () => '/fixture/claude', isClaudeExecutableUnspawnable: () => false }));
  const { KnowledgeAgent } = await import('./src/services/worker/knowledge/KnowledgeAgent.ts');
  const { CorpusStore } = await import('./src/services/worker/knowledge/CorpusStore.ts');
  const store = new CorpusStore();
  const agent = new KnowledgeAgent(store);
  const outcomes = [];
  for (scenario of ['query-abort', 'query-reprime-abort', 'query-success', 'query-reprime-success', 'prime-abort']) {
    controller = new AbortController();
    sdkCalls = [];
    const corpus = { version: 1, name: scenario, description: '', created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(), filter: {},
      stats: { observation_count: 0, token_estimate: 0, date_range: { earliest: '', latest: '' }, type_breakdown: {} },
      system_prompt: 'Use only this corpus', session_id: scenario === 'prime-abort' ? null : 'old-session', observations: [] };
    store.write(corpus);
    let result; let abortedAsRequested = false; let unexpectedError;
    try {
      result = scenario === 'prime-abort'
        ? await agent.prime(corpus, { abortController: controller })
        : await agent.query(corpus, 'question', { abortController: controller });
    } catch (error) {
      abortedAsRequested = error === aborted;
      if (!abortedAsRequested) unexpectedError = String(error);
    }
    outcomes.push({ scenario, result, abortedAsRequested, unexpectedError,
      memorySession: corpus.session_id, diskSession: store.read(corpus.name).session_id, sdkCalls });
  }
  console.log(JSON.stringify(outcomes));
`;

interface Outcome {
  scenario: string;
  result?: { answer: string; session_id: string };
  abortedAsRequested: boolean;
  unexpectedError?: string;
  memorySession: string | null;
  diskSession: string | null;
  sdkCalls: Array<string | null>;
}

describe('knowledge query cancellation at SDK completion', () => {
  let outcomes: Outcome[];
  const outcomeFor = (scenario: string) => outcomes.find(entry => entry.scenario === scenario)!;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-query-cancel-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') },
        stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      outcomes = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects a quietly aborted query without persisting its session or retrying', () => {
    const outcome = outcomeFor('query-abort');
    expect(outcome.abortedAsRequested).toBe(true);
    expect(outcome.result).toBeUndefined();
    expect(outcome.unexpectedError).toBeUndefined();
    expect(outcome.memorySession).toBe('old-session');
    expect(outcome.diskSession).toBe('old-session');
    expect(outcome.sdkCalls).toEqual(['old-session']);
  });

  it('keeps the successful reprime session when its follow-up query is abandoned', () => {
    const outcome = outcomeFor('query-reprime-abort');
    expect(outcome.abortedAsRequested).toBe(true);
    expect(outcome.result).toBeUndefined();
    expect(outcome.unexpectedError).toBeUndefined();
    expect(outcome.memorySession).toBe('primed-session');
    expect(outcome.diskSession).toBe('primed-session');
    expect(outcome.sdkCalls).toEqual(['old-session', null, 'primed-session']);
  });

  it('still persists complete normal and reprime query results', () => {
    for (const scenario of ['query-success', 'query-reprime-success']) {
      const outcome = outcomeFor(scenario);
      expect(outcome.abortedAsRequested).toBe(false);
      expect(outcome.unexpectedError).toBeUndefined();
      expect(outcome.result).toEqual({ answer: 'Complete answer', session_id: 'answer-session' });
      expect(outcome.diskSession).toBe('answer-session');
    }
  });

  it('preserves the existing no-persistence rule for an abandoned prime', () => {
    const outcome = outcomeFor('prime-abort');
    expect(outcome.abortedAsRequested).toBe(true);
    expect(outcome.result).toBeUndefined();
    expect(outcome.memorySession).toBeNull();
    expect(outcome.diskSession).toBeNull();
    expect(outcome.sdkCalls).toEqual([null]);
  });
});
