import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realPaths from '../../src/shared/paths.js';
import { buildRefreshTask, resolveRefreshAgents } from '../../src/services/work-view/refresh-task.js';
import { runAgentTask, type AgentTask } from '../../src/services/agent-runner/run.js';
import type { UsableAgent } from '../../src/services/agent-runner/detect.js';
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

interface FetchCall { url: string; body: Record<string, unknown> }

/** The provider's answer, or a refusal when `status` is set. */
function fakeFetch(replies: Array<{ status?: number; text?: string }>): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    calls.push({ url: String(input), body: JSON.parse(String(init.body ?? '{}')) });
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

  it('runs nothing by default: the refresh is the owner\'s model spend, and a local CLI is no stand-in', async () => {
    for (const provider of ['openrouter', 'openai-compatible', 'cmem']) {
      await withApiProvider(provider, dir => {
        // A local Claude Code run spends the owner's Anthropic subscription, which is exactly
        // what choosing another provider was meant to stop; the API refresh is opt-in.
        expect(resolveRefreshAgents(dir)).toEqual({ allowedAgents: [], stayOnFirstUsableAgent: true });
      });
    }
  });

  it('CLAUDE_MEM_WORK_VIEW_AGENT=api opts in: the API provider and no local agent', async () => {
    for (const provider of ['openrouter', 'openai-compatible', 'cmem']) {
      await withApiProvider(provider, dir => {
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_PROVIDER: provider, CLAUDE_MEM_WORK_VIEW_AGENT: 'api' }));
        expect(resolveRefreshAgents(dir)).toEqual({ allowedAgents: ['api'], preferredAgent: 'api', stayOnFirstUsableAgent: true });
      });
    }
  });

  it('a local agent the owner named still wins over the provider', async () => {
    await withApiProvider('openrouter', dir => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_WORK_VIEW_AGENT: 'claude-code' }));
      expect(resolveRefreshAgents(dir)).toEqual({ allowedAgents: ['claude-code'], preferredAgent: 'claude-code', stayOnFirstUsableAgent: true });
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
        if (prompt.includes('Do only section 3')) return everyRequestInOther(prompt);
        return JSON.stringify({ narrative: 'Started.', preferences: [] });
      };
      expect(await task.run(ask, 'api')).toBe('1 new conversations grouped, 1 requests reviewed, 1 requests placed, story written.');
      // The API agent has no Read tool, so the input files travel with the question.
      expect(prompts.some(prompt => prompt.includes('The following input files are supplied inline'))).toBe(true);
      expect(prompts.some(prompt => prompt.includes('You have no memory tools'))).toBe(true);
    });
  });
});
