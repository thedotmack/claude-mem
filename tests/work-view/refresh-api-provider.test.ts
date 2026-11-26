import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realPaths from '../../src/shared/paths.js';
import { buildRefreshTask, resolveRefreshAgents } from '../../src/services/work-view/refresh-task.js';
import { runAgentTask, type AgentTask } from '../../src/services/agent-runner/run.js';
import type { UsableAgent } from '../../src/services/agent-runner/detect.js';
import { logger } from '../../src/utils/logger.js';
import { everyRequestInOther, focusWriter } from '../helpers/fake-focus-writer.js';

/**
 * Snapshot the real namespace EAGERLY, before the mock.module below: `import * as x`
 * yields a live namespace object that bun re-points when the module is mocked.
 */
const realPathsSnapshot = { ...realPaths };

const DAY = 86400000, NOW = 100 * DAY;
const PLUGIN_ROOT = join(import.meta.dir, '..', '..', 'plugin');
const key = (session: string) => JSON.stringify(['conversation', 'claude', session]);

/** The settings file the mocked paths module hands out. */
let settingsPath = '';
/** A .env that holds nothing, so no real credential is read. */
let envFilePath = '';

mock.module('../../src/shared/paths.js', () => ({
  ...realPathsSnapshot,
  paths: { ...realPathsSnapshot.paths, settings: () => settingsPath, envFile: () => envFilePath },
  settings: () => settingsPath,
  USER_SETTINGS_PATH: settingsPath,
}));

interface FetchCall { url: string; body: Record<string, unknown>; signal: AbortSignal }

/** The provider's answer, or a refusal when `status` is set. */
function fakeFetch(replies: Array<{ status?: number; text?: string }>): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    calls.push({ url: String(input), body: JSON.parse(String(init.body ?? '{}')), signal: init.signal });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    const text = reply.text ?? JSON.stringify({ choices: [{ message: { content: 'the provider answer' } }] });
    return new Response(text, { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls };
}

function fixtureDatabase() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, project TEXT, user_prompt TEXT, started_at_epoch INTEGER);
    CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, tool_name TEXT, tool_input TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, type TEXT, title TEXT, subtitle TEXT, created_at_epoch INTEGER);
    CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);`);
  db.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(1, 'claude', 'a', 'm1', 'repo/tree', 'Build the release cards', NOW - 3 * DAY);
  db.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)').run(1, 1, 'Build the release cards', NOW - 3 * DAY);
  return db;
}

/** A database handle the worker may close without closing the shared fixture. */
const handle = (database: Database) => () => ({ prepare: database.prepare.bind(database), close() {} });

const localAgents = (...ids: Array<UsableAgent['id']>): UsableAgent[] =>
  (['claude-code', 'codex', 'gemini'] as const).map(id => ({ id, path: ids.includes(id) ? `/bin/${id}` : null, authenticated: ids.includes(id), reason: 'test' }));

describe('the My Work refresh on an API provider', () => {
  let savedFetch: typeof fetch;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    savedEnv = { ...process.env };
    for (const name of Object.keys(process.env)) if (name.startsWith('CLAUDE_MEM_')) delete process.env[name];
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    for (const name of Object.keys(process.env)) if (name.startsWith('CLAUDE_MEM_')) delete process.env[name];
    Object.assign(process.env, savedEnv);
  });

  afterAll(() => { mock.module('../../src/shared/paths.js', () => realPathsSnapshot); });

  /** A data dir whose settings name an API provider, and the settings path the runner reads. */
  const withApiProvider = async <T>(provider: string, body: (dir: string) => T | Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'refresh-api-'));
    try {
      const settings = { CLAUDE_MEM_PROVIDER: provider, CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-test', CLAUDE_MEM_OPENROUTER_MODEL: 'vendor/model' };
      writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
      settingsPath = join(dir, 'settings.json');
      envFilePath = join(dir, '.env');
      return await body(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it('an empty setting keeps main\'s behaviour: the first logged-in agent and only that one, never the API provider', async () => {
    for (const provider of ['openrouter', 'openai-compatible', 'cmem']) {
      await withApiProvider(provider, dir => {
        // The API refresh spends that provider's credit, so it runs only when the owner sets `api`.
        // Every CMEM Pro install is `openrouter`, and its My Work keeps refreshing on its logged-in agent.
        const choice = resolveRefreshAgents(dir);
        expect(choice).toEqual({ stayOnFirstUsableAgent: true });
        expect(choice.allowedAgents).toBeUndefined();
      });
    }
  });

  it('CLAUDE_MEM_WORK_VIEW_AGENT=api opts in: the API provider and no local agent', async () => {
    for (const provider of ['openrouter', 'openai-compatible', 'cmem']) {
      await withApiProvider(provider, dir => {
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_PROVIDER: provider, CLAUDE_MEM_WORK_VIEW_AGENT: 'api' }));
        expect(resolveRefreshAgents(dir)).toEqual({ allowedAgents: ['api'], preferredAgent: 'api', stayOnFirstUsableAgent: true, apiLimits: { timeoutMs: 600_000, maxOutputTokens: 16_000 } });
      });
    }
  });

  it('CLAUDE_MEM_WORK_VIEW_AGENT=all carries the same API limits, since it can fall through to the api agent', async () => {
    await withApiProvider('openai-compatible', dir => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_PROVIDER: 'openai-compatible', CLAUDE_MEM_WORK_VIEW_AGENT: 'all',
        CLAUDE_MEM_WORK_VIEW_API_TIMEOUT_MS: '1800000', CLAUDE_MEM_WORK_VIEW_MAX_OUTPUT_TOKENS: '32000',
      }));
      expect(resolveRefreshAgents(dir).apiLimits).toEqual({ timeoutMs: 1_800_000, maxOutputTokens: 32_000 });
    });
  });

  it('an invalid limit warns once, naming the default it uses', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await withApiProvider('openai-compatible', dir => {
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
          CLAUDE_MEM_PROVIDER: 'openai-compatible', CLAUDE_MEM_WORK_VIEW_AGENT: 'api', CLAUDE_MEM_WORK_VIEW_MAX_OUTPUT_TOKENS: '16k-warn-once',
        }));
        expect(resolveRefreshAgents(dir).apiLimits?.maxOutputTokens).toBe(16_000);
        expect(resolveRefreshAgents(dir).apiLimits?.maxOutputTokens).toBe(16_000);
      });
      const warnings = warn.mock.calls.filter(call => String(call[1]).includes('CLAUDE_MEM_WORK_VIEW_MAX_OUTPUT_TOKENS'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0][2]).toMatchObject({ value: '16k-warn-once', default: 16_000 });
    } finally {
      warn.mockRestore();
    }
  });

  it('a local agent the owner named still wins over the provider', async () => {
    await withApiProvider('openrouter', dir => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_WORK_VIEW_AGENT: 'claude-code' }));
      expect(resolveRefreshAgents(dir)).toEqual({ allowedAgents: ['claude-code'], preferredAgent: 'claude-code', stayOnFirstUsableAgent: true });
    });
  });

  it('runs setup on an explicitly selected own endpoint and requires a separate choice for cmem.ai', async () => {
    await withApiProvider('openai-compatible', async dir => {
      const task: AgentTask = { reason: 'setup-scan', cwd: dir, allowedAgents: ['api'],
        claudeCode: { plugins: [], tools: [], allowedTools: [], readableFolders: [] }, run: ask => ask('fixture prompt', {}) };
      const calls = fakeFetch([{}]).calls;
      for (const baseUrl of ['http://localhost:1234/v1', 'https://cmem.ai/api/v1']) {
        writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'openai-compatible',
          CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: baseUrl, CLAUDE_MEM_OPENAI_COMPAT_MODEL: 'fixture-model',
          CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'fixture' }));
        expect((await runAgentTask(task)).state).toBe(baseUrl.startsWith('http:') ? 'ok' : 'waiting-for-agent');
      }
      expect(calls.map(call => new URL(call.url).hostname)).toEqual(['localhost']);
    });
  });

  it('the task the worker builds carries the API agent once the owner opts in', async () => {
    await withApiProvider('openrouter', dir => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_WORK_VIEW_AGENT: 'api' }));
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 1, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(fixtureDatabase()), now: () => NOW, saveFocus: focusWriter(fixtureDatabase()).save });
      expect(task.allowedAgents).toEqual(['api']);
      expect(task.preferredAgent).toBe('api');
    });
  });

  it.each([
    { name: 'defaults', file: {}, env: {}, timeoutMs: 600_000, tokens: 16_000 },
    {
      name: 'settings file',
      file: { CLAUDE_MEM_WORK_VIEW_API_TIMEOUT_MS: 1_800_000, CLAUDE_MEM_WORK_VIEW_MAX_OUTPUT_TOKENS: '100000' },
      env: {}, timeoutMs: 1_800_000, tokens: 100_000,
    },
    {
      name: 'environment overrides',
      file: { CLAUDE_MEM_WORK_VIEW_API_TIMEOUT_MS: '3000', CLAUDE_MEM_WORK_VIEW_MAX_OUTPUT_TOKENS: 2048 },
      env: { CLAUDE_MEM_WORK_VIEW_API_TIMEOUT_MS: '900000', CLAUDE_MEM_WORK_VIEW_MAX_OUTPUT_TOKENS: '32000' },
      timeoutMs: 900_000, tokens: 32_000,
    },
    {
      name: 'overflowing timeout',
      file: { CLAUDE_MEM_WORK_VIEW_API_TIMEOUT_MS: 2 ** 31, CLAUDE_MEM_WORK_VIEW_MAX_OUTPUT_TOKENS: 512 },
      env: {}, timeoutMs: 600_000, tokens: 512,
    },
    {
      name: 'invalid token count',
      file: { CLAUDE_MEM_WORK_VIEW_API_TIMEOUT_MS: 750, CLAUDE_MEM_WORK_VIEW_MAX_OUTPUT_TOKENS: '16k' },
      env: {}, timeoutMs: 750, tokens: 16_000,
    },
  ])('applies the expected token cap and deadline across a compatibility resend ($name)', async ({ file, env, timeoutMs, tokens }) => {
    await withApiProvider('openai-compatible', async dir => {
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_PROVIDER: 'openai-compatible', CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: 'http://localhost:1234/v1',
        CLAUDE_MEM_OPENAI_COMPAT_MODEL: 'local/model', CLAUDE_MEM_WORK_VIEW_AGENT: 'api', ...file,
      }));
      Object.assign(process.env, env);
      const task = buildRefreshTask({
        reason: 'manual', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT,
        needs: { due: 0, ungrouped: 1, goalsStale: false, unplaced: 0, needed: true },
        localDeviceId: () => '', openDatabase: fixtureDatabase,
      });
      const { calls } = fakeFetch([
        { status: 400, text: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." },
        { text: JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'incomplete' } }] }) },
      ]);
      const deadline = new AbortController().signal;
      const timer = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline);
      try {
        const result = await runAgentTask({ ...task, run: ask => ask('question', {}) });
        expect(result.error).toContain(`${tokens}-token answer limit`);
        expect(timer.mock.calls).toEqual([[timeoutMs]]);
        expect(calls).toHaveLength(2);
        expect(calls.every(call => call.signal === deadline)).toBe(true);
        expect(calls[0].body.max_tokens).toBe(tokens);
        expect(calls[0].body.max_completion_tokens).toBeUndefined();
        expect(calls[1].body.max_tokens).toBeUndefined();
        expect(calls[1].body.max_completion_tokens).toBe(tokens);
      } finally { timer.mockRestore(); }
    });
  });

  it('the runner starts no local CLI, no OAuth token and no Claude Code session', async () => {
    await withApiProvider('openrouter', async () => {
      const { calls } = fakeFetch([{}]);
      let detected = 0, envBuilt = 0, queried = 0;
      const task: AgentTask = {
        reason: 'test',
        cwd: process.cwd(),
        claudeCode: { plugins: [], tools: ['Read'], allowedTools: [], readableFolders: [] },
        allowedAgents: ['api'],
        preferredAgent: 'api',
        stayOnFirstUsableAgent: true,
        run: async (ask, agent) => `ran on ${agent}: ${await ask('the question', {})}`,
      };
      const result = await runAgentTask(task, {
        detect: async () => { detected++; return localAgents('claude-code'); },
        query: (async () => { queried++; }) as any,
        buildEnv: async () => { envBuilt++; return {}; },
      });
      expect(result.state).toBe('ok');
      expect(result.agent).toBe('api');
      expect(result.result).toContain('ran on api');
      // No local CLI is probed, no environment is built (so no Claude Code OAuth token is
      // injected) and the Claude Code SDK is never started.
      expect(detected).toBe(0);
      expect(envBuilt).toBe(0);
      expect(queried).toBe(0);
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    });
  });

  it('after a 401 the rest of the run sends nothing', async () => {
    await withApiProvider('openrouter', async () => {
      const { calls } = fakeFetch([{ status: 401, text: JSON.stringify({ error: { message: 'invalid api key' } }) }]);
      const outcomes: string[] = [];
      const task: AgentTask = {
        reason: 'test',
        cwd: process.cwd(),
        claudeCode: { plugins: [], tools: ['Read'], allowedTools: [], readableFolders: [] },
        allowedAgents: ['api'],
        preferredAgent: 'api',
        stayOnFirstUsableAgent: true,
        // Like a refresh with many review batches: every batch is asked even when an earlier one failed.
        run: async (ask) => {
          for (let batch = 0; batch < 5; batch++) {
            await ask(`batch ${batch}`, {}).catch((error: Error) => { outcomes.push(error.message); });
          }
          throw new Error(outcomes[0]);
        },
      };
      const result = await runAgentTask(task, { detect: async () => [], query: (async () => {}) as any, buildEnv: async () => ({}) });
      expect(result.state).toBe('failed');
      expect(outcomes.length).toBe(5);
      expect(outcomes.every(message => /not authenticated/i.test(message))).toBe(true);
      // One request reached the provider; the other four steps reported the same refusal without sending.
      expect(calls.length).toBe(1);
    });
  });

  it('a refused API call is not handed to a local agent', async () => {
    await withApiProvider('openrouter', async () => {
      fakeFetch([{ status: 401, text: JSON.stringify({ error: { message: 'invalid api key' } }) }]);
      let detected = 0;
      const task: AgentTask = {
        reason: 'test',
        cwd: process.cwd(),
        claudeCode: { plugins: [], tools: ['Read'], allowedTools: [], readableFolders: [] },
        allowedAgents: ['api'],
        preferredAgent: 'api',
        stayOnFirstUsableAgent: true,
        run: async (ask) => { await ask('the question', {}); return 'unreachable'; },
      };
      const result = await runAgentTask(task, {
        detect: async () => { detected++; return localAgents('claude-code'); },
        query: (async () => {}) as any,
        buildEnv: async () => ({}),
      });
      expect(result.state).toBe('failed');
      expect(result.agent).toBe('api');
      expect(result.attempts.map(attempt => attempt.agent)).toEqual(['api']);
      expect(result.error).toMatch(/not authenticated/i);
      // The local CLIs were never even looked at: the refusal is the provider's, not a reason
      // to spend another account.
      expect(detected).toBe(0);
    });
  });

  it('the API agent gets the input files inline, since it has no file tools', async () => {
    await withApiProvider('openrouter', async dir => {
      const database = fixtureDatabase();
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 1, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: focusWriter(database).save });
      const prompts: string[] = [];
      const ask = async (prompt: string) => {
        prompts.push(prompt);
        if (prompt.includes('Do only section 1')) return JSON.stringify({ groups: [{ title: 'Release cards', conversations: [key('a')] }] });
        if (prompt.includes('Do only section 2')) {
          const [show] = JSON.parse(prompt.split(`--- ${/is in (.+?\.json)/.exec(prompt)?.[1]} ---\n`)[1] ?? '[]');
          return JSON.stringify({ reviews: [{ groupId: show.groupId, state: 'in-progress', percent: 10, summary: 'Started.', reviewBasis: show.reviewBasis }] });
        }
        if (prompt.includes('Do only section 4')) return everyRequestInOther(prompt);
        return JSON.stringify({ narrative: 'Started.', preferences: [] });
      };
      expect(await task.run(ask, 'api')).toBe('1 new conversations grouped, 1 requests reviewed, 1 requests placed, story written.');
      // The API agent has no Read tool, so the input files travel with the question.
      expect(prompts.some(prompt => prompt.includes('The following input files are supplied inline'))).toBe(true);
      expect(prompts.some(prompt => prompt.includes('You have no memory tools'))).toBe(true);
    });
  });

  it('an answer cut off at the token limit is kept in failed-answers/ and the failure names the file', async () => {
    await withApiProvider('openrouter', async dir => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_WORK_VIEW_AGENT: 'api' }));
      const database = fixtureDatabase();
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 1, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: focusWriter(database).save });
      // The API agent's truncation refusal, carrying the partial answer the way askApiTarget throws it (#6432).
      // Before the fix this error left the run with no trace of the answer: only parse and validation
      // refusals were kept, so a degenerating model was invisible in failed-answers/.
      const partial = '{"groups": [{"title": "Release cards", "conversations": [   ';
      const ask = async (prompt: string) => {
        if (prompt.includes('Do only section 1')) {
          throw Object.assign(new Error('the OpenAI-compatible endpoint stopped at the 16000-token answer limit (finish reason: length); the answer is incomplete.'), { rawAnswer: partial });
        }
        return JSON.stringify({ narrative: 'Started.', preferences: [] });
      };
      const error = await task.run(ask, 'api').then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/^grouping \(raw answer: .+failed-answers.+grouping-api\.txt\): /);
      expect((error as { answerRefused?: boolean }).answerRefused).toBe(true);
      const saved = readdirSync(join(dir, 'failed-answers'));
      expect(saved.length).toBe(1);
      expect(readFileSync(join(dir, 'failed-answers', saved[0]), 'utf8')).toBe(partial);
    });
  });

  it('a review answer cut off at the token limit is kept in failed-answers/ and the failure names the file', async () => {
    await withApiProvider('openrouter', async dir => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_WORK_VIEW_AGENT: 'api' }));
      const database = fixtureDatabase();
      const task = buildRefreshTask({ localDeviceId: () => '', needs: { due: 0, ungrouped: 1, goalsStale: false, unplaced: 0, needed: true }, reason: 'scheduled', dataDir: dir, ledgerDir: dir, pluginRoot: PLUGIN_ROOT, openDatabase: handle(database), now: () => NOW, saveFocus: focusWriter(database).save });
      // reviewBatch asks directly, outside askAndSave, so its cut-off answers need the same keeping:
      // before the fix the partial review text was lost and the failure named no file.
      const partial = '{"reviews": [{"groupId": "g1", "state": "in-progress", "summary": "Started revi';
      const ask = async (prompt: string) => {
        if (prompt.includes('Do only section 1')) return JSON.stringify({ groups: [{ title: 'Release cards', conversations: [key('a')] }] });
        if (prompt.includes('Do only section 2')) {
          throw Object.assign(new Error('the OpenAI-compatible endpoint stopped at the 16000-token answer limit (finish reason: length); the answer is incomplete.'), { rawAnswer: partial });
        }
        return JSON.stringify({ narrative: 'Started.', preferences: [] });
      };
      const error = await task.run(ask, 'api').then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/^review \(raw answer: .+failed-answers.+review-api\.txt\): /);
      expect((error as { answerRefused?: boolean }).answerRefused).toBe(true);
      const saved = readdirSync(join(dir, 'failed-answers'));
      expect(saved.length).toBe(1);
      expect(readFileSync(join(dir, 'failed-answers', saved[0]), 'utf8')).toBe(partial);
    });
  });
});
