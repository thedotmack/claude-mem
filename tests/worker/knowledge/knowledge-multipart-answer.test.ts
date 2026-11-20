import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The real KnowledgeAgent and CorpusStore run in an isolated child. Only the
// external SDK stream, CLI discovery and credential preparation are replaced.
// https://code.claude.com/docs/en/agent-sdk/streaming-output#message-flow:
// each assistant message carries its own completed content block, even when
// several blocks share one API message ID.
const fixture = String.raw`
  import { mock } from 'bun:test';
  let scenario = '';
  let calls = [];
  let sequence = 0;
  const session = 'current-knowledge-session';
  const first = 'The database indexes source evidence (#7).\n\n';
  const second = 'The worker retains the original prompt (#8).';
  const assistant = (block) => ({
    type: 'assistant', session_id: session, uuid: 'frame-' + (++sequence),
    parent_tool_use_id: null,
    message: { id: 'msg-complete-answer', type: 'message', role: 'assistant',
      model: 'protocol-fixture', content: [block], stop_reason: null,
      stop_sequence: null, usage: { input_tokens: 12, output_tokens: 20 } },
  });
  const success = () => ({
    type: 'result', session_id: session, subtype: 'success', is_error: false,
    result: first + second,
  });
  mock.module('@anthropic-ai/claude-agent-sdk', () => ({
    query: ({ options }) => {
      calls.push({ resume: options.resume ?? null, tools: options.tools });
      return (async function* () {
        if (scenario === 'resume' && options.resume === 'old-session') {
          yield { type: 'result', session_id: 'unsaved-session',
            subtype: 'error_during_execution', is_error: true,
            errors: ['No conversation found with session ID: old-session'] };
          return;
        }
        yield { type: 'system', subtype: 'init', session_id: session };
        if (!options.resume) {
          yield assistant({ type: 'text', text: 'Primed corpus acknowledgement.' });
          yield success();
          return;
        }
        yield assistant({ type: 'text', text: scenario === 'single' ? first + second : first });
        if (scenario !== 'single') {
          yield assistant({ type: 'thinking', thinking: 'not answer text', signature: 'fixture' });
          yield assistant({ type: 'text', text: second });
        }
        if (scenario === 'textless-tail') {
          yield assistant({ type: 'redacted_thinking', data: 'not answer text' });
        }
        if (scenario === 'missing') return;
        if (scenario === 'failure') {
          yield { type: 'result', session_id: session, subtype: 'error_max_turns',
            is_error: true, errors: ['turn budget exceeded'] };
          return;
        }
        yield success();
        if (scenario === 'process-exit') throw new Error('process exit after successful result');
      })();
    },
  }));
  mock.module('./src/shared/EnvManager.ts', () => ({
    buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: process.env.PATH }),
  }));
  mock.module('./src/shared/find-claude-executable.ts', () => ({
    findClaudeExecutable: () => '/protocol-fixture/claude',
    isClaudeExecutableUnspawnable: () => false,
  }));
  const { KnowledgeAgent } = await import('./src/services/worker/knowledge/KnowledgeAgent.ts');
  const { CorpusStore } = await import('./src/services/worker/knowledge/CorpusStore.ts');
  const store = new CorpusStore();
  const agent = new KnowledgeAgent(store);
  const outcomes = [];
  for (scenario of ['multipart', 'textless-tail', 'process-exit', 'resume', 'single', 'failure', 'missing']) {
    calls = [];
    const corpus = {
      version: 1, name: scenario, description: 'Knowledge answer fixture',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      filter: {}, stats: { observation_count: 0, token_estimate: 0,
        date_range: { earliest: '', latest: '' }, type_breakdown: {} },
      system_prompt: 'Answer only from the corpus', session_id: 'old-session', observations: [],
    };
    store.write(corpus);
    let result, error;
    try { result = await agent.query(corpus, 'Which evidence is retained?'); }
    catch (caught) { error = String(caught); }
    outcomes.push({
      scenario, result, error, calls, memorySession: corpus.session_id,
      diskSession: store.read(corpus.name).session_id,
    });
  }
  console.log(JSON.stringify(outcomes));
`;

interface Outcome {
  scenario: string;
  result?: { answer: string; session_id: string };
  error?: string;
  calls: Array<{ resume: string | null; tools: string[] }>;
  memorySession: string;
  diskSession: string;
}

describe('complete knowledge answers across SDK content blocks', () => {
  let outcomes: Outcome[] = [];
  const answer = 'The database indexes source evidence (#7).\n\nThe worker retains the original prompt (#8).';

  beforeAll(() => {
    const directory = mkdtempSync(join(tmpdir(), 'knowledge-multipart-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(directory, 'data'),
          CLAUDE_CONFIG_DIR: join(directory, 'config') },
        stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      outcomes = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const scenario of ['multipart', 'textless-tail', 'process-exit', 'resume', 'single']) {
    it('returns the complete answer for ' + scenario, () => {
      const outcome = outcomes.find(entry => entry.scenario === scenario)!;
      expect(outcome.error).toBeUndefined();
      expect(outcome.result).toEqual({ answer, session_id: 'current-knowledge-session' });
      expect(outcome.memorySession).toBe('current-knowledge-session');
      expect(outcome.diskSession).toBe('current-knowledge-session');
      expect(outcome.calls.map(call => call.resume)).toEqual(
        scenario === 'resume' ? ['old-session', null, 'current-knowledge-session'] : ['old-session'],
      );
      expect(outcome.calls.every(call => call.tools.length === 0)).toBe(true);
    });
  }

  for (const scenario of ['failure', 'missing']) {
    it('rejects ' + scenario + ' without returning partial text or persisting its session', () => {
      const outcome = outcomes.find(entry => entry.scenario === scenario)!;
      expect(outcome.result).toBeUndefined();
      expect(outcome.error).toContain(
        scenario === 'failure' ? 'turn budget exceeded' : 'ended without a successful result',
      );
      expect(outcome.memorySession).toBe('old-session');
      expect(outcome.diskSession).toBe('old-session');
      expect(outcome.calls.map(call => call.resume)).toEqual(['old-session']);
    });
  }
});
