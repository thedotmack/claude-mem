import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { mock } from 'bun:test';
  let scenario = '';
  let sdkCalls = [];
  mock.module('@anthropic-ai/claude-agent-sdk', () => ({ query: ({ options }) => {
    sdkCalls.push(options.resume ?? null);
    return (async function* () {
      if (scenario === 'query-resume-not-found') {
        // What the CLI writes in stream-json mode when --resume names a session it has no transcript for, before exiting 1.
        if (options.resume === 'old-session') {
          yield { type: 'result', session_id: 'unsaved-session', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: old-session'] };
          throw new Error('Claude Code process exited with code 1');
        }
        yield { type: 'system', subtype: 'init', session_id: 'reprimed-session' };
        if (options.resume) yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Reprimed answer' }] } };
        yield { type: 'result', session_id: 'reprimed-session', subtype: 'success', is_error: false, result: 'done' };
        return;
      }
      yield { type: 'system', subtype: 'init', session_id: 'new-session' };
      if (scenario.includes('query')) yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Partial answer' }] } };
      if (scenario.includes('throw-before')) throw new Error('network failed before result');
      if (scenario.includes('missing')) return;
      yield { type: 'result', session_id: 'new-session', subtype: scenario.includes('success') || scenario.includes('is-error') ? 'success' : 'error_max_turns', is_error: scenario.includes('is-error') || scenario.endsWith('-error') && !scenario.includes('subtype-error'), errors: ['turn budget exceeded'], ...(scenario.includes('is-error') ? { result: 'API Error: prompt is too long' } : {}) };
      if (scenario.includes('throw-after')) throw new Error('process exit after result');
    })();
  } }));
  // These external boundaries are replaced so the fixture never reads host credentials or starts Claude.
  mock.module('./src/shared/EnvManager.ts', () => ({ buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: process.env.PATH }) }));
  mock.module('./src/shared/find-claude-executable.ts', () => ({ findClaudeExecutable: () => '/fixture/claude' }));
  const { KnowledgeAgent } = await import('./src/services/worker/knowledge/KnowledgeAgent.ts');
  const { CorpusStore } = await import('./src/services/worker/knowledge/CorpusStore.ts');
  const store = new CorpusStore();
  const agent = new KnowledgeAgent(store);
  const outcomes = [];
  for (scenario of ['prime-error', 'query-error', 'prime-is-error', 'query-is-error', 'prime-subtype-error', 'query-subtype-error', 'prime-throw-before', 'query-throw-before', 'prime-missing', 'query-missing', 'prime-success', 'query-success', 'prime-success-throw-after', 'query-success-throw-after', 'query-resume-not-found']) {
    sdkCalls = [];
    const corpus = { version: 1, name: scenario, description: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), filter: {}, stats: { observation_count: 0, token_estimate: 0, date_range: { earliest: '', latest: '' }, type_breakdown: {} }, system_prompt: 'Answer using only the corpus', session_id: scenario.includes('query') ? 'old-session' : null, observations: [] };
    store.write(corpus);
    let result; let error;
    try { result = scenario.includes('query') ? await agent.query(corpus, 'question') : await agent.prime(corpus); }
    catch (e) { error = String(e); }
    outcomes.push({ scenario, result, error, memorySession: corpus.session_id, diskSession: store.read(corpus.name).session_id, sdkCalls });
  }
  console.log(JSON.stringify(outcomes));
`;

interface Outcome {
  scenario: string;
  result?: any;
  error?: string;
  memorySession: string | null;
  diskSession: string | null;
  /** The `resume` session id of each SDK call, in order (null for a prime). */
  sdkCalls: Array<string | null>;
}

describe('knowledge agent SDK outcomes', () => {
  let outcomes: Outcome[] = [];
  const outcomeFor = (scenario: string): Outcome => outcomes.find((entry) => entry.scenario === scenario)!;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-outcomes-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../../..'), env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      outcomes = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('persists only successful terminal outcomes and rejects partial failures', () => {
    for (const entry of outcomes) {
      if (entry.scenario === 'query-resume-not-found') continue;
      // None of these failures is an expired session, so none may pay for a reprime.
      expect(entry.sdkCalls, entry.scenario).toHaveLength(1);
      if (entry.scenario.includes('success')) {
        expect(entry.error).toBeUndefined();
        expect(entry.memorySession).toBe('new-session');
        expect(entry.diskSession).toBe('new-session');
        if (entry.scenario.includes('query')) {
          expect(entry.result.answer).toBe('Partial answer');
          expect(entry.result.session_id).toBe('new-session');
        } else expect(entry.result).toBe('new-session');
      } else {
        expect(entry.error, entry.scenario).toBeDefined();
        expect(entry.result).toBeUndefined();
        expect(entry.memorySession).toBe(entry.scenario.includes('query') ? 'old-session' : null);
        expect(entry.diskSession).toBe(entry.memorySession);
      }
    }
  });

  it('puts the failed result text in the error', () => {
    for (const scenario of ['prime-is-error', 'query-is-error']) {
      expect(outcomeFor(scenario).error, scenario).toContain('API Error: prompt is too long');
    }
    for (const scenario of ['prime-error', 'query-error', 'prime-subtype-error', 'query-subtype-error']) {
      expect(outcomeFor(scenario).error, scenario).toContain('turn budget exceeded');
    }
  });

  it('reprimes and asks again when the resumed session no longer exists', () => {
    const entry = outcomeFor('query-resume-not-found');
    expect(entry.error).toBeUndefined();
    expect(entry.result).toEqual({ answer: 'Reprimed answer', session_id: 'reprimed-session' });
    expect(entry.memorySession).toBe('reprimed-session');
    expect(entry.diskSession).toBe('reprimed-session');
    // The failed resume, the reprime, then the question again on the new session.
    expect(entry.sdkCalls).toEqual(['old-session', null, 'reprimed-session']);
  });
});
