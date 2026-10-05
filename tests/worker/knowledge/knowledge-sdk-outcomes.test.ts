import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { mock } from 'bun:test';
  let scenario = '';
  mock.module('@anthropic-ai/claude-agent-sdk', () => ({ query: () => (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'new-session' };
    if (scenario.includes('query')) yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Partial answer' }] } };
    if (scenario.includes('throw-before')) throw new Error('network failed before result');
    if (scenario.includes('missing')) return;
    yield { type: 'result', session_id: 'new-session', subtype: scenario.includes('success') || scenario.includes('is-error') ? 'success' : 'error_max_turns', is_error: scenario.includes('is-error') || scenario.endsWith('-error') && !scenario.includes('subtype-error'), errors: ['turn budget exceeded'] };
    if (scenario.includes('throw-after')) throw new Error('process exit after result');
  })() }));
  // These external boundaries are replaced so the fixture never reads host credentials or starts Claude.
  mock.module('./src/shared/EnvManager.ts', () => ({ buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: process.env.PATH }) }));
  mock.module('./src/shared/find-claude-executable.ts', () => ({ findClaudeExecutable: () => '/fixture/claude' }));
  const { KnowledgeAgent } = await import('./src/services/worker/knowledge/KnowledgeAgent.ts');
  const { CorpusStore } = await import('./src/services/worker/knowledge/CorpusStore.ts');
  const store = new CorpusStore();
  const agent = new KnowledgeAgent(store);
  const outcomes = [];
  for (scenario of ['prime-error', 'query-error', 'prime-is-error', 'query-is-error', 'prime-subtype-error', 'query-subtype-error', 'prime-throw-before', 'query-throw-before', 'prime-missing', 'query-missing', 'prime-success', 'query-success', 'prime-success-throw-after', 'query-success-throw-after']) {
    const corpus = { version: 1, name: scenario, description: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), filter: {}, stats: { observation_count: 0, token_estimate: 0, date_range: { earliest: '', latest: '' }, type_breakdown: {} }, system_prompt: 'Answer using only the corpus', session_id: scenario.includes('query') ? 'old-session' : null, observations: [] };
    store.write(corpus);
    let result; let error;
    try { result = scenario.includes('query') ? await agent.query(corpus, 'question') : await agent.prime(corpus); }
    catch (e) { error = String(e); }
    outcomes.push({ scenario, result, error, memorySession: corpus.session_id, diskSession: store.read(corpus.name).session_id });
  }
  console.log(JSON.stringify(outcomes));
`;

describe('knowledge agent SDK outcomes', () => {
  it('persists only successful terminal outcomes and rejects partial failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knowledge-outcomes-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../../..'), env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const outcomes = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      for (const entry of outcomes) {
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
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
