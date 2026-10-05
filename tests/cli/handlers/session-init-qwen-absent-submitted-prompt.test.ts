import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';
import {
  isQwenCodeHookEvent,
  isQwenTranscriptPath,
  recordSessionPrompt,
  sessionInitHandler,
  setSessionInitDependenciesForTesting,
} from '../../../src/cli/handlers/session-init.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { SessionRoutes } from '../../../src/services/worker/http/routes/SessionRoutes.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';

// #4224 taught session-init to read Qwen's `submitted_prompt` and to skip the
// send when the host sends that field empty. One case is left: Qwen's docs say
// continuation and ToolResult sends leave `submitted_prompt` out entirely, so
// the field arrives absent and the handler falls back to `prompt` -- which is
// also empty, and became a `[media prompt]` row per tool round.
//
// The absence cannot be read as "not a user turn" everywhere: Qwen and Claude
// Code run the same `hook claude-code session-init` command, and on Claude Code
// an empty prompt is a real image-only submission (#928). So the skip is scoped
// to Qwen, recognised from QWEN_PROJECT_DIR in the hook environment or from a
// `transcript_path` under `~/.qwen/`.
describe('isQwenTranscriptPath', () => {
  it('recognises a Qwen transcript path', () => {
    expect(isQwenTranscriptPath('/home/dot/.qwen/tmp/abc123/chats/session.json')).toBe(true);
  });

  it('recognises a Windows-style Qwen transcript path', () => {
    expect(isQwenTranscriptPath('C:\\Users\\dot\\.qwen\\tmp\\abc123\\chats\\session.json')).toBe(true);
  });

  it('is not fooled by a project directory that merely starts with .qwen', () => {
    expect(isQwenTranscriptPath('/home/dot/projects/.qwen-notes/chats/session.json')).toBe(false);
  });

  it('is false for a Claude Code transcript path or no path at all', () => {
    expect(isQwenTranscriptPath('/home/dot/.claude/projects/x/session.jsonl')).toBe(false);
    expect(isQwenTranscriptPath(undefined)).toBe(false);
    expect(isQwenTranscriptPath('')).toBe(false);
  });
});

// Qwen keeps sessions and transcripts under QWEN_RUNTIME_DIR,
// `advanced.runtimeOutputDir` or QWEN_HOME when one is set, so the path alone
// misses them. Qwen sets QWEN_PROJECT_DIR for every command hook.
const relocatedQwenTranscript = '/data/qwen-runtime/projects/p/chats/s.jsonl';

describe('isQwenCodeHookEvent', () => {
  it('trusts QWEN_PROJECT_DIR for a transcript Qwen keeps outside ~/.qwen', () => {
    expect(isQwenCodeHookEvent(relocatedQwenTranscript, { QWEN_PROJECT_DIR: '/p' })).toBe(true);
  });

  it('falls back to a ~/.qwen transcript path without the env var', () => {
    expect(isQwenCodeHookEvent('/home/dot/.qwen/tmp/abc123/chats/session.json', {})).toBe(true);
    expect(isQwenCodeHookEvent(relocatedQwenTranscript, {})).toBe(false);
  });

  it('is false without a transcript path, even with QWEN_PROJECT_DIR set', () => {
    // The transcript watcher records prompts without a transcript path, from a
    // worker that may have inherited QWEN_PROJECT_DIR from a Qwen hook.
    expect(isQwenCodeHookEvent(undefined, { QWEN_PROJECT_DIR: '/p' })).toBe(false);
    expect(isQwenCodeHookEvent('', { QWEN_PROJECT_DIR: '/p' })).toBe(false);
  });
});

describe('sessionInitHandler Qwen sends with no submitted_prompt field', () => {
  const cwd = join(tmpdir(), 'claude-mem-qwen-absent-field-test');
  const qwenTranscript = '/home/dot/.qwen/tmp/abc123/chats/session.json';

  interface WorkerCall { apiPath: string; method: string; body: Record<string, unknown> }

  // The hook environment is passed explicitly, so a QWEN_PROJECT_DIR in the
  // environment running the tests never changes their outcome.
  function install(workerCalls: WorkerCall[], hookEnvironment: NodeJS.ProcessEnv = {}): void {
    setSessionInitDependenciesForTesting({
      shouldTrackProject: () => true,
      loadFromFileOnce: () => ({ CLAUDE_MEM_SEMANTIC_INJECT: 'false' }),
      resolveRuntimeContext: () => ({ runtime: 'worker' }),
      isWorkerFallback: () => false,
      readHookEnvironment: () => hookEnvironment,
      executeWithWorkerFallback: async (apiPath: string, method: string, body: unknown) => {
        workerCalls.push({ apiPath, method, body: body as Record<string, unknown> });
        return { sessionDbId: 42, promptNumber: 7 };
      },
    });
  }

  afterEach(() => {
    setSessionInitDependenciesForTesting();
  });

  it('stores no prompt when Qwen omits the field and the prompt is empty', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls);

    // A Qwen ToolResult send: no `submitted_prompt` key, empty `prompt`. The
    // session already exists from the turn that WAS submitted, so nothing is
    // stored. This is the case #4224 could not reach, because it only handles
    // the field being present and empty.
    const result = await sessionInitHandler.execute({
      sessionId: 'qwen-toolresult-send',
      cwd,
      platform: 'claude-code',
      prompt: '',
      transcriptPath: qwenTranscript,
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(workerCalls).toEqual([]);
  });

  it('treats a whitespace-only prompt on Qwen the same way', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls);

    await sessionInitHandler.execute({
      sessionId: 'qwen-whitespace-send',
      cwd,
      platform: 'claude-code',
      prompt: '   ',
      transcriptPath: qwenTranscript,
    });

    expect(workerCalls).toEqual([]);
  });

  it('still stores a real Qwen submission that happens to be empty-free', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls);

    // The host-scoping must not swallow genuine user turns on Qwen: text in
    // `prompt` with the field absent is the legacy shape and still stores.
    await sessionInitHandler.execute({
      sessionId: 'qwen-real-text-send',
      cwd,
      platform: 'claude-code',
      prompt: 'please review the diff',
      transcriptPath: qwenTranscript,
    });

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].body.prompt).toBe('please review the diff');
  });

  it('keeps storing the media placeholder for a Claude Code image-only turn', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls);

    // The #928 regression guard. Claude Code sends no `submitted_prompt` field
    // at all, so without host-scoping this would regress into a dropped
    // session: an empty prompt there is a real image-only submission.
    await sessionInitHandler.execute({
      sessionId: 'claude-image-only-submission',
      cwd,
      platform: 'claude-code',
      prompt: '',
      transcriptPath: '/home/dot/.claude/projects/x/session.jsonl',
    });

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].body.prompt).toBe('[media prompt]');
  });

  it('keeps storing the media placeholder when no host can be identified', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls);

    // With no transcript path there is nothing to scope the skip to, so the
    // pre-existing behaviour stands.
    await sessionInitHandler.execute({
      sessionId: 'unknown-host-empty-prompt',
      cwd,
      platform: 'claude-code',
      prompt: '',
    });

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].body.prompt).toBe('[media prompt]');
  });

  it('stores no prompt for a relocated Qwen transcript when the hook environment names Qwen', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls, { QWEN_PROJECT_DIR: '/p' });

    await sessionInitHandler.execute({
      sessionId: 'qwen-relocated-toolresult-send',
      cwd,
      platform: 'claude-code',
      prompt: '',
      transcriptPath: relocatedQwenTranscript,
    });

    expect(workerCalls).toEqual([]);
  });

  it('keeps storing the media placeholder for that path without QWEN_PROJECT_DIR', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls);

    await sessionInitHandler.execute({
      sessionId: 'unknown-host-relocated-path',
      cwd,
      platform: 'claude-code',
      prompt: '',
      transcriptPath: relocatedQwenTranscript,
    });

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].body.prompt).toBe('[media prompt]');
  });

  it('leaves the transcript watcher alone in a worker that inherited QWEN_PROJECT_DIR', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls, { QWEN_PROJECT_DIR: '/p' });

    // The watcher's entry point, called without a transcript path.
    await recordSessionPrompt({
      sessionId: 'watcher-empty-turn',
      cwd,
      platform: 'claude-code',
      prompt: '',
    });

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].body.prompt).toBe('[media prompt]');
  });
});

// End to end through the real adapter, session-init handler, session routes and
// SQLite, adapted from the reproduction in #4402. It pins the case #4402's
// review raised: a session whose FIRST send arrives without `submitted_prompt`
// (Qwen only sets it at supported submission boundaries) is still created with
// its prompt, and only the empty ToolResult send after it is skipped.
describe('Qwen session prompts through the real session routes', () => {
  afterEach(() => {
    setSessionInitDependenciesForTesting();
  });

  it('records a first send without submitted_prompt and skips only the empty ToolResult send', async () => {
    const cleanup: Array<() => void | Promise<unknown>> = [];
    try {
      const cwd = mkdtempSync(join(tmpdir(), 'claude-mem-qwen-first-send-'));
      cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
      const settings = spyOn(SettingsDefaultsManager, 'loadFromFile')
        .mockImplementation(() => SettingsDefaultsManager.getAllDefaults());
      cleanup.push(() => settings.mockRestore());
      const store = new SessionStore(':memory:');
      cleanup.push(() => store.close());
      const dbManager = {
        getSessionStore: () => store,
        getSessionById: (id: number) => store.getSessionById(id),
        getChromaSync: () => null,
        getCloudSync: () => null,
      } as unknown as DatabaseManager;
      const sessionManager = new SessionManager(dbManager);
      cleanup.push(() => sessionManager.shutdownAll());
      const routes = new SessionRoutes(sessionManager, dbManager, {} as never, {} as never, {} as never,
        { broadcastNewPrompt() {}, broadcastSessionStarted() {} } as never, {} as never, {} as never);
      const app = express();
      app.use(express.json());
      routes.setupRoutes(app);
      const server = app.listen(0, '127.0.0.1');
      cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
      await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');

      let hookEnvironment: NodeJS.ProcessEnv = { QWEN_PROJECT_DIR: cwd };
      setSessionInitDependenciesForTesting({
        shouldTrackProject: () => true,
        loadFromFileOnce: () => ({ CLAUDE_MEM_SEMANTIC_INJECT: 'false' }),
        resolveRuntimeContext: () => ({ runtime: 'worker' }),
        isWorkerFallback: () => false,
        readHookEnvironment: () => hookEnvironment,
        executeWithWorkerFallback: async (apiPath: string, method: string, body: unknown) => {
          const response = await fetch(`http://127.0.0.1:${address.port}${apiPath}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          expect(response.ok).toBe(true);
          return response.json();
        },
      });

      const submit = (raw: Record<string, unknown>) => sessionInitHandler.execute({
        ...claudeCodeAdapter.normalizeInput({ cwd, hook_event_name: 'UserPromptSubmit', ...raw }),
        platform: 'claude-code',
      });
      const promptsOf = (sessionId: string) => store.db.query(
        'SELECT prompt_number, prompt_text FROM user_prompts WHERE content_session_id = ? ORDER BY prompt_number',
      ).all(sessionId);

      // Transcripts moved out of ~/.qwen, so only the hook environment says Qwen.
      const transcript_path = relocatedQwenTranscript;
      await submit({ session_id: 'qwen-session', prompt: 'please review the diff', transcript_path });
      await submit({ session_id: 'qwen-session', prompt: '', transcript_path });
      await submit({ session_id: 'qwen-session', prompt: 'expanded model input', submitted_prompt: 'now fix it', transcript_path });

      expect(store.db.query('SELECT COUNT(*) AS count FROM sdk_sessions WHERE content_session_id = ?').get('qwen-session'))
        .toEqual({ count: 1 });
      expect(promptsOf('qwen-session')).toEqual([
        { prompt_number: 1, prompt_text: 'please review the diff' },
        { prompt_number: 2, prompt_text: 'now fix it' },
      ]);

      // Claude Code sets no QWEN_PROJECT_DIR, and an empty prompt there is a
      // real image-only turn (#928).
      hookEnvironment = {};
      await submit({ session_id: 'claude-session', prompt: '', transcript_path: '/home/dot/.claude/projects/x/s.jsonl' });
      expect(promptsOf('claude-session')).toEqual([{ prompt_number: 1, prompt_text: '[media prompt]' }]);
    } finally {
      for (const release of cleanup.reverse()) await release();
    }
  });
});
