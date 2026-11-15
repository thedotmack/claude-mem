// Continuing a conversation from My Work, through the worker's routes: the guards on each route, the request checks, the
// 202 and the live event every open window hears, one turn per conversation, the read of where a turn would run and of
// what was sent, and local API token mode. Every CLI is a fake spawn, so nothing runs and nothing is spent. The lookup is
// a real SessionStore (the one worker-service.ts wires in) and the folders are real, all under the repo's gitignored
// .scratch/test-runs.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { spawn, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import express from 'express';
import { listenOnEphemeralPort } from '../../../helpers/ephemeral-port.js';
import { scratchDir } from '../../../helpers/scratch-dir.js';
import { removeTempDir } from '../../../helpers/temp-dir.js';
import type { UsableAgent } from '../../../../src/services/agent-runner/detect.js';
import { Server } from '../../../../src/services/server/Server.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { ConversationContinuationRunner } from '../../../../src/services/work-view/conversation-continuation-runner.js';
import { WorkViewRoutes, workViewLoopbackOnly } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import type { ConversationContinuation, ConversationContinuationNotice } from '../../../../src/shared/conversation-continuation.js';
import { LOCAL_API_TOKEN_HEADER } from '../../../../src/shared/local-api-token.js';

const FIXTURES = join(import.meta.dir, '..', '..', '..', 'fixtures', 'conversation-continuation');

const CLAUDE_SESSION = '0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const CODEX_SESSION = '019a2b3c-4d5e-7f60-8a1b-2c3d4e5f6a7b';
const CLAUDE_SESSION_WITHOUT_FOLDER = '5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f';
const CODEX_SESSION_NOT_RECORDED = '7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
const NON_UUID_CLAUDE_SESSION = 'manual-content-project-claude';
const CLAUDE_ARGUMENTS = ['--resume', CLAUDE_SESSION, '-p', '--output-format', 'json'];
const CODEX_ARGUMENTS = ['exec', 'resume', CODEX_SESSION, '-', '--skip-git-repo-check'];
const STILL_RUNNING_REFUSAL = 'This conversation is still answering your last message from here. Wait for its reply, or stop it, before you send another.';
const UNAVAILABLE = 'Continuing a conversation is unavailable on this worker.';

class FakeStream extends EventEmitter {
  setEncoding(): this { return this; }
}

/**
 * Fake pids start above any real one (macOS allows at most 99,999 and Linux at most 4,194,304), so the SIGINT a Stop sends
 * to a fake child's process group reaches no process: kill answers ESRCH, which runCommand reads as nothing left to stop.
 */
let nextFakePid = 20_000_000;

/** A CLI as runCommand sees one. The test decides when it exits and what it printed. */
class FakeChild extends EventEmitter {
  readonly pid = nextFakePid++;
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdinText: string | null = null;
  stdin = Object.assign(new EventEmitter(), { end: (text: string) => { this.stdinText = text; } });
  exit(exitCode: number, output: { stdout?: string } = {}): void {
    if (output.stdout) this.stdout.emit('data', output.stdout);
    this.emit('close', exitCode);
  }
}

interface SpawnCall { command: string; args: string[]; options: SpawnOptions; child: FakeChild }

const usableAgents = (): UsableAgent[] => [
  { id: 'claude-code', path: '/usr/local/bin/claude', authenticated: true, reason: 'test login' },
  { id: 'codex', path: '/usr/local/bin/codex', authenticated: true, reason: 'test login' },
  { id: 'gemini', path: null, authenticated: false, reason: 'not installed' },
];

/** Claude Code's `--output-format json` output with `"verbose": true` (the owner's setting), its reply set to `replyText`. */
function claudeOutput(replyText: string): string {
  const messages = JSON.parse(readFileSync(join(FIXTURES, 'claude-result-verbose-array.json'), 'utf8')) as Record<string, unknown>[];
  messages[messages.length - 1] = { ...messages[messages.length - 1], result: replyText };
  return JSON.stringify(messages);
}

let fileFolder: string;
let store: SessionStore;
let databasePath: string;
let folderPresent: string;
let deletedRecordedFolder: string;

beforeAll(() => {
  fileFolder = scratchDir('conversation-continuation-routes');
  databasePath = join(fileFolder, 'claude-mem.db');
  store = new SessionStore(databasePath);
  folderPresent = join(fileFolder, 'checkout');
  mkdirSync(folderPresent);
  const cleanedUpWorktree = join(fileFolder, 'cleaned-up-worktree');
  deletedRecordedFolder = join(cleanedUpWorktree, 'packages', 'app');
  mkdirSync(deletedRecordedFolder, { recursive: true });
  rmSync(cleanedUpWorktree, { recursive: true, force: true });
  const record = (contentSessionId: string, platform: string, folder: string | null) => {
    const sessionDbId = store.createSDKSession(contentSessionId, 'example', 'Remember the word marmalade.', undefined, platform);
    if (folder) store.setSessionCwd(sessionDbId, folder);
  };
  record(CLAUDE_SESSION, 'claude', folderPresent);
  record(CODEX_SESSION, 'codex', deletedRecordedFolder);
  record(CLAUDE_SESSION_WITHOUT_FOLDER, 'claude', null);
  record(NON_UUID_CLAUDE_SESSION, 'claude', folderPresent);
});

afterAll(async () => {
  store.close();
  await removeTempDir(fileFolder);
});

/** A runner over the real SessionStore lookup and a fake spawn, wired to the routes the way worker-service.ts wires it. */
function runnerFor(routes: () => WorkViewRoutes) {
  const calls: SpawnCall[] = [];
  let detectCalls = 0;
  const unread: ConversationContinuation[] = [];
  const waiting: Array<(exchange: ConversationContinuation) => void> = [];
  const runner = new ConversationContinuationRunner({
    recordedFolderForConversation: (platform, conversationSessionId) => store.getRecordedFolderForConversation(platform, conversationSessionId),
    detectAgents: async () => { detectCalls += 1; return usableAgents(); },
    spawnImpl: ((command: string, args: string[], options: SpawnOptions) => {
      const call: SpawnCall = { command, args, options, child: new FakeChild() };
      calls.push(call);
      return call.child;
    }) as unknown as typeof spawn,
    onChange: exchange => {
      routes().publishConversationContinuation(exchange);
      const waiter = waiting.shift();
      if (waiter) waiter(exchange); else unread.push(exchange);
    },
  });
  return {
    runner,
    calls,
    detectCalls: () => detectCalls,
    /** The next exchange the runner reports as ended. */
    nextEnded: () => unread.length > 0 ? Promise.resolve(unread.shift()!) : new Promise<ConversationContinuation>(resolve => waiting.push(resolve)),
  };
}

let testFolderCount = 0;
/** Routes that touch nothing of this computer's: their own review, setup, settings and rules files, and no refresh. */
function isolatedRoutesOptions() {
  const testFolder = join(fileFolder, `routes-${++testFolderCount}`);
  mkdirSync(testFolder);
  return {
    databasePath, reviewPath: join(testFolder, 'review.db'), pollIntervalMs: 20, humanCopy: null, ledgerDir: null, autoRefresh: null,
    focusShares: null, setupStatePath: join(testFolder, 'setup-state.json'), settingsPath: join(testFolder, 'settings.json'),
    rulesFilePath: join(testFolder, 'MY-RULES.md'), claudeInstructionsPath: join(testFolder, 'claude', 'CLAUDE.md'),
  };
}

type RoutesUnderTest = ReturnType<typeof runnerFor> & { routes: WorkViewRoutes; origin: string; close: () => Promise<void> };
const openedRoutes: RoutesUnderTest[] = [];
afterEach(async () => {
  for (const opened of openedRoutes.splice(0)) await opened.close();
});

/**
 * The work-view routes, with a runner unless `withRunner` is false. On a bare express app, like the other work-view route
 * tests, so each refusal below is the routes' own guard; with `localApiToken`, on the worker's real Server, whose
 * middleware puts local API token mode ahead of every route.
 */
async function startRoutes({ withRunner = true, localApiToken }: { withRunner?: boolean; localApiToken?: string } = {}): Promise<RoutesUnderTest> {
  let routes!: WorkViewRoutes;
  const turns = runnerFor(() => routes);
  routes = new WorkViewRoutes({ ...isolatedRoutesOptions(), ...(withRunner ? { conversationContinuationRunner: turns.runner } : {}) });
  let port: number;
  let closeServer: () => Promise<void>;
  if (localApiToken) {
    const server = new Server({
      getInitializationComplete: () => true, getMcpReady: () => true, onShutdown: () => Promise.resolve(), onRestart: () => Promise.resolve(),
      workerPath: '/test/worker-service.cjs', getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
      localApiToken: { getToken: () => localApiToken },
    });
    port = await listenOnEphemeralPort(server);
    server.registerRoutes(routes);
    closeServer = () => server.close();
  } else {
    const app = express();
    app.use(express.json());
    routes.setupRoutes(app);
    let server!: HttpServer;
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    port = address.port;
    closeServer = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  const opened: RoutesUnderTest = { ...turns, routes, origin: `http://127.0.0.1:${port}`, close: async () => { routes.close(); await closeServer(); } };
  openedRoutes.push(opened);
  return opened;
}

const postJson = (origin: string, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body),
});
const sendMessage = (origin: string, body: unknown, headers?: Record<string, string>) => postJson(origin, '/api/work-view/conversations/continue', body, headers);
const pressStop = (origin: string, body: unknown, headers?: Record<string, string>) => postJson(origin, '/api/work-view/conversations/stop', body, headers);
const readConversation = (origin: string, platform: string, conversationSessionId: string, headers: Record<string, string> = {}) => fetch(
  `${origin}/api/work-view/conversations/continuation?platform=${encodeURIComponent(platform)}&conversationSessionId=${encodeURIComponent(conversationSessionId)}`,
  { headers },
);

/** The event stream My Work opens (`?view=overview`, local-source.ts), read frame by frame. */
async function openWindow(origin: string) {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/work-view/events?view=overview`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const frames = () => {
    const blocks = text.split('\n\n');
    // The last block is a frame still arriving, or empty.
    blocks.pop();
    return blocks.flatMap(block => {
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return event !== undefined && data !== undefined ? [{ event, data: JSON.parse(data) }] : [];
    });
  };
  return {
    /** Reads until `count` frames of this kind have arrived, and answers with their data in order. */
    async framesOf(event: string, count: number): Promise<any[]> {
      for (;;) {
        const matching = frames().filter(frame => frame.event === event).map(frame => frame.data);
        if (matching.length >= count) return matching;
        const { value, done } = await reader.read();
        if (done) throw new Error(`The event stream ended after ${matching.length} ${event} frames.`);
        text += decoder.decode(value, { stream: true });
      }
    },
    close: () => controller.abort(),
  };
}

describe('the guards on every conversation route', () => {
  it('refuses a forwarded or rebound request, a cross-site or foreign page, and a non-JSON body with 403, and starts nothing', async () => {
    const opened = await startRoutes();
    const conversation = { platform: 'claude', conversationSessionId: CLAUDE_SESSION };
    const refusedHeaders: Record<string, string>[] = [
      { 'X-Forwarded-For': '203.0.113.9' },
      { Host: 'rebound.example' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { Origin: 'https://evil.example' },
      { Origin: 'http://127.0.0.1:1' },
    ];
    for (const headers of refusedHeaders) {
      expect((await readConversation(opened.origin, 'claude', CLAUDE_SESSION, headers)).status).toBe(403);
      expect((await sendMessage(opened.origin, { ...conversation, ownerMessage: 'Which word?' }, headers)).status).toBe(403);
      expect((await pressStop(opened.origin, conversation, headers)).status).toBe(403);
    }
    for (const path of ['/api/work-view/conversations/continue', '/api/work-view/conversations/stop']) {
      const notJson = await fetch(`${opened.origin}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: opened.origin }, body: JSON.stringify({ ...conversation, ownerMessage: 'Which word?' }),
      });
      expect(notJson.status).toBe(403);
    }
    expect(opened.calls).toHaveLength(0);
    expect(opened.detectCalls()).toBe(0);
  });

  it('refuses a request whose connection comes from another computer', () => {
    // The routes above listen on 127.0.0.1, so the connection check of workViewLoopbackOnly, each route's first guard, is
    // exercised here directly; the forwarded and rebound requests above show that guard is the one on these routes.
    const statuses: number[] = [];
    let reachedTheRoute = false;
    const response = { status(code: number) { statuses.push(code); return response; }, json() { return response; } };
    const fromAnotherComputer = { ip: '203.0.113.9', socket: { remoteAddress: '203.0.113.9' }, header: (name: string) => (name === 'host' ? '127.0.0.1:37777' : undefined) };
    workViewLoopbackOnly(fromAnotherComputer as never, response as never, () => { reachedTheRoute = true; });
    expect(statuses).toEqual([403]);
    expect(reachedTheRoute).toBe(false);
  });
});

describe('the request checks', () => {
  it('answers an unknown tool, an id that is not a UUID, an empty message and an unknown field with validateBody 400s, and starts nothing', async () => {
    const opened = await startRoutes();
    const refusedBodies: Array<[unknown, (issue: { path: unknown[]; code: string }) => boolean]> = [
      [{ platform: 'gemini', conversationSessionId: CLAUDE_SESSION, ownerMessage: 'Which word?' }, issue => issue.path[0] === 'platform'],
      [{ platform: 'claude', conversationSessionId: NON_UUID_CLAUDE_SESSION, ownerMessage: 'Which word?' }, issue => issue.path[0] === 'conversationSessionId'],
      [{ platform: 'claude', conversationSessionId: CLAUDE_SESSION, ownerMessage: ' \n ' }, issue => issue.path[0] === 'ownerMessage'],
      [{ platform: 'claude', conversationSessionId: CLAUDE_SESSION }, issue => issue.path[0] === 'ownerMessage'],
      // Nothing it does not name, such as the click token PR #6054's answer route takes.
      [{ platform: 'claude', conversationSessionId: CLAUDE_SESSION, ownerMessage: 'Which word?', token: 'a-click-token' }, issue => issue.code === 'unrecognized_keys'],
    ];
    for (const [body, namesTheField] of refusedBodies) {
      const response = await sendMessage(opened.origin, body);
      expect(response.status).toBe(400);
      const answer = await response.json() as { error: string; issues: Array<{ path: unknown[]; code: string }> };
      expect(answer.error).toBe('ValidationError');
      expect(answer.issues.some(namesTheField)).toBe(true);
    }
    const stopWithoutUuid = await pressStop(opened.origin, { platform: 'claude', conversationSessionId: NON_UUID_CLAUDE_SESSION });
    expect(stopWithoutUuid.status).toBe(400);
    expect((await stopWithoutUuid.json()).error).toBe('ValidationError');
    expect(opened.calls).toHaveLength(0);
    expect(opened.detectCalls()).toBe(0);
  });

  it('answers a read that names no conversation of a tool it can continue with a 400 sentence', async () => {
    const opened = await startRoutes();
    const queries = [
      `platform=gemini&conversationSessionId=${CLAUDE_SESSION}`,
      'platform=claude',
      `conversationSessionId=${CLAUDE_SESSION}`,
      `platform=claude&platform=codex&conversationSessionId=${CLAUDE_SESSION}`,
    ];
    for (const query of queries) {
      const response = await fetch(`${opened.origin}/api/work-view/conversations/continuation?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Name the conversation with platform (claude or codex) and conversationSessionId.' });
    }
  });

  it('answers 503 on each conversation route of a worker without a runner', async () => {
    const opened = await startRoutes({ withRunner: false });
    const conversation = { platform: 'claude', conversationSessionId: CLAUDE_SESSION };
    for (const response of [
      await readConversation(opened.origin, 'claude', CLAUDE_SESSION),
      await sendMessage(opened.origin, { ...conversation, ownerMessage: 'Which word?' }),
      await pressStop(opened.origin, conversation),
    ]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: UNAVAILABLE });
    }
  });
});

describe('a Send', () => {
  it('answers 202 with the running exchange; every open window hears it start and reply by id and state only, and the read answers the rest', async () => {
    const opened = await startRoutes();
    const firstWindow = await openWindow(opened.origin);
    const secondWindow = await openWindow(opened.origin);
    try {
      // A window is listening once its stream has sent the first view.
      await firstWindow.framesOf('work-view-overview', 1);
      await secondWindow.framesOf('work-view-overview', 1);
      const response = await sendMessage(opened.origin, { platform: 'claude', conversationSessionId: CLAUDE_SESSION, ownerMessage: 'Which word? Reply with only the word.' });
      expect(response.status).toBe(202);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const { exchange: running } = await response.json() as { exchange: ConversationContinuation };
      expect(running).toMatchObject({
        platform: 'claude', conversationSessionId: CLAUDE_SESSION, state: 'running', ownerMessage: 'Which word? Reply with only the word.', ranInFolder: folderPresent,
      });
      expect(opened.calls).toHaveLength(1);
      expect(opened.calls[0].args).toEqual(CLAUDE_ARGUMENTS);
      expect(opened.calls[0].options.cwd).toBe(folderPresent);
      expect(opened.calls[0].child.stdinText).toBe('Which word? Reply with only the word.');

      opened.calls[0].child.exit(0, { stdout: claudeOutput('marmalade') });
      // The stream checks no origin, so another page on this computer can read it: each notice has exactly these four
      // keys, and the message, the reply and the folder are not among them.
      const startedNotice: ConversationContinuationNotice = { exchangeId: running.exchangeId, platform: 'claude', conversationSessionId: CLAUDE_SESSION, state: 'running' };
      const repliedNotice: ConversationContinuationNotice = { ...startedNotice, state: 'replied' };
      for (const window of [firstWindow, secondWindow]) {
        expect(await window.framesOf('conversation-continuation', 2)).toStrictEqual([startedNotice, repliedNotice]);
      }
      // The whole exchange is answered by the guarded read.
      const { exchanges } = await (await readConversation(opened.origin, 'claude', CLAUDE_SESSION)).json() as { exchanges: ConversationContinuation[] };
      expect(exchanges).toEqual([{
        exchangeId: running.exchangeId, platform: 'claude', conversationSessionId: CLAUDE_SESSION, state: 'replied',
        ownerMessage: 'Which word? Reply with only the word.', startedAtEpochMs: running.startedAtEpochMs, endedAtEpochMs: expect.any(Number),
        replyText: 'marmalade', deniedToolCallCount: 0, ranInFolder: folderPresent,
      }]);
      expect(exchanges[0].endedAtEpochMs).toBeGreaterThanOrEqual(running.startedAtEpochMs);
    } finally {
      firstWindow.close();
      secondWindow.close();
    }
  });

  it('refuses a second Send to the conversation while the first is running with 409 and its sentence, and runs one turn', async () => {
    const opened = await startRoutes();
    const conversation = { platform: 'claude', conversationSessionId: CLAUDE_SESSION };
    expect((await sendMessage(opened.origin, { ...conversation, ownerMessage: 'first' })).status).toBe(202);
    const second = await sendMessage(opened.origin, { ...conversation, ownerMessage: 'second' });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: STILL_RUNNING_REFUSAL });
    expect(opened.calls).toHaveLength(1);
    expect(opened.calls[0].child.stdinText).toBe('first');
  });

  it("refuses a conversation it can't continue with 409 and the target's sentence, and starts nothing", async () => {
    const opened = await startRoutes();
    const refusals: Array<[string, string, string]> = [
      ['claude', CLAUDE_SESSION_WITHOUT_FOLDER, 'No folder was recorded for this Claude Code conversation, so it can’t be continued from here.'],
      ['codex', CODEX_SESSION_NOT_RECORDED, 'This Codex conversation is not recorded on this computer, so it can’t be continued from here.'],
    ];
    for (const [platform, conversationSessionId, sentence] of refusals) {
      const response = await sendMessage(opened.origin, { platform, conversationSessionId, ownerMessage: 'Which word?' });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: sentence });
    }
    expect(opened.calls).toHaveLength(0);
    expect(opened.detectCalls()).toBe(0);
  });

  it('stops the running turn with 200 and its exchange, which ends failed once the CLI exits; a Stop with nothing running is 409', async () => {
    const opened = await startRoutes();
    const conversation = { platform: 'claude', conversationSessionId: CLAUDE_SESSION };
    const nothingRunning = await pressStop(opened.origin, conversation);
    expect(nothingRunning.status).toBe(409);
    expect(await nothingRunning.json()).toEqual({ error: 'Nothing sent from here is running in this conversation.' });

    const window = await openWindow(opened.origin);
    try {
      await window.framesOf('work-view-overview', 1);
      const { exchange: running } = await (await sendMessage(opened.origin, { ...conversation, ownerMessage: 'Count slowly to 200, one number per line.' })).json() as { exchange: ConversationContinuation };
      const stopped = await pressStop(opened.origin, conversation);
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toEqual({ exchange: running });
      // As Claude Code did in a real run stopped while one of its tools ran: it printed nothing and exited 0.
      opened.calls[0].child.exit(0);
      expect(await opened.nextEnded()).toMatchObject({ exchangeId: running.exchangeId, state: 'failed', failureText: 'You stopped this turn.' });
      // A failed end is pushed by id and state only too: its failure text is answered by the guarded read alone.
      const startedNotice: ConversationContinuationNotice = { exchangeId: running.exchangeId, platform: 'claude', conversationSessionId: CLAUDE_SESSION, state: 'running' };
      const failedNotice: ConversationContinuationNotice = { ...startedNotice, state: 'failed' };
      expect(await window.framesOf('conversation-continuation', 2)).toStrictEqual([startedNotice, failedNotice]);
      const { exchanges } = await (await readConversation(opened.origin, 'claude', CLAUDE_SESSION)).json() as { exchanges: ConversationContinuation[] };
      expect(exchanges.map(({ state, failureText }) => ({ state, failureText }))).toEqual([{ state: 'failed', failureText: 'You stopped this turn.' }]);
      expect(opened.calls).toHaveLength(1);
    } finally {
      window.close();
    }
  });
});

describe('reading a conversation', () => {
  it('answers where its turn would run, or the sentence for each refusal, with no exchanges yet, and never cached', async () => {
    const opened = await startRoutes();
    const read = async (platform: string, conversationSessionId: string) => {
      const response = await readConversation(opened.origin, platform, conversationSessionId);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      return response.json();
    };
    expect(await read('claude', CLAUDE_SESSION)).toEqual({
      target: { canContinue: true, recordedFolder: folderPresent, runsInFolder: folderPresent, recordedFolderIsGone: false }, exchanges: [],
    });
    expect(await read('codex', CODEX_SESSION)).toEqual({
      target: { canContinue: true, recordedFolder: deletedRecordedFolder, runsInFolder: fileFolder, recordedFolderIsGone: true }, exchanges: [],
    });
    const refusals: Array<[string, string, string]> = [
      ['claude', CLAUDE_SESSION_WITHOUT_FOLDER, 'No folder was recorded for this Claude Code conversation, so it can’t be continued from here.'],
      ['claude', NON_UUID_CLAUDE_SESSION, 'This Claude Code conversation has no resumable session id, so it can’t be continued from here.'],
      ['codex', CODEX_SESSION_NOT_RECORDED, 'This Codex conversation is not recorded on this computer, so it can’t be continued from here.'],
    ];
    for (const [platform, conversationSessionId, refusalText] of refusals) {
      expect(await read(platform, conversationSessionId)).toEqual({ target: { canContinue: false, refusalText, recordedFolder: null }, exchanges: [] });
    }
    expect(opened.calls).toHaveLength(0);
    // The read runs no agent detection, which spawns the CLIs' status commands: the page asks it for each row it opens.
    expect(opened.detectCalls()).toBe(0);
  });

  it('after two Sends, answers both exchanges in order, each with its message and reply', async () => {
    const opened = await startRoutes();
    const conversation = { platform: 'codex', conversationSessionId: CODEX_SESSION };
    const send = async (ownerMessage: string) => (await (await sendMessage(opened.origin, { ...conversation, ownerMessage })).json() as { exchange: ConversationContinuation }).exchange;
    const first = await send('Remember the word marmalade. Reply only: ok');
    opened.calls[0].child.exit(0, { stdout: 'ok\n' });
    await opened.nextEnded();
    const second = await send('Which word? Reply with only the word.');
    opened.calls[1].child.exit(0, { stdout: 'marmalade\n' });
    await opened.nextEnded();

    const { exchanges } = await (await readConversation(opened.origin, 'codex', CODEX_SESSION)).json() as { exchanges: ConversationContinuation[] };
    expect(exchanges.map(({ exchangeId, state, ownerMessage, replyText, ranInFolder }) => ({ exchangeId, state, ownerMessage, replyText, ranInFolder }))).toEqual([
      { exchangeId: first.exchangeId, state: 'replied', ownerMessage: 'Remember the word marmalade. Reply only: ok', replyText: 'ok', ranInFolder: fileFolder },
      { exchangeId: second.exchangeId, state: 'replied', ownerMessage: 'Which word? Reply with only the word.', replyText: 'marmalade', ranInFolder: fileFolder },
    ]);
    expect(opened.calls.map(call => call.args)).toEqual([CODEX_ARGUMENTS, CODEX_ARGUMENTS]);
  });
});

describe('nothing starts by itself', () => {
  it('runs no turn when routes start with a runner and an empty map, while windows open, reconnect and read, or as timers run', async () => {
    const opened = await startRoutes();
    // An open stream reads the work view on a timer, every pollIntervalMs, through backgroundSnapshot: count those ticks.
    const timed = opened.routes as unknown as { backgroundSnapshot: () => Promise<unknown> };
    const backgroundSnapshot = timed.backgroundSnapshot.bind(opened.routes);
    let timerTicks = 0;
    let threeTimerTicksRan!: () => void;
    const threeTimerTicks = new Promise<void>(resolve => { threeTimerTicksRan = resolve; });
    timed.backgroundSnapshot = () => {
      if (++timerTicks === 3) threeTimerTicksRan();
      return backgroundSnapshot();
    };
    const firstWindow = await openWindow(opened.origin);
    try {
      await firstWindow.framesOf('work-view-overview', 1);
    } finally {
      firstWindow.close();
    }
    // The page reconnecting, as it does after a worker restart.
    const reconnectedWindow = await openWindow(opened.origin);
    try {
      await reconnectedWindow.framesOf('work-view-overview', 1);
      expect((await (await readConversation(opened.origin, 'claude', CLAUDE_SESSION)).json()).exchanges).toEqual([]);
      await threeTimerTicks;
    } finally {
      reconnectedWindow.close();
    }
    expect(opened.calls).toHaveLength(0);
    expect(opened.detectCalls()).toBe(0);
  });
});

describe('local API token mode (#5141)', () => {
  it('refuses a Send, a Stop and a read without the token with 401 and starts nothing; with the token they get through', async () => {
    const TOKEN = 'conversation-continuation-routes-test-token';
    const opened = await startRoutes({ localApiToken: TOKEN });
    const conversation = { platform: 'claude', conversationSessionId: CLAUDE_SESSION };
    const message = { ...conversation, ownerMessage: 'Which word? Reply with only the word.' };
    const withToken = { [LOCAL_API_TOKEN_HEADER]: TOKEN };

    expect((await sendMessage(opened.origin, message)).status).toBe(401);
    expect((await sendMessage(opened.origin, message, { [LOCAL_API_TOKEN_HEADER]: 'not-the-token' })).status).toBe(401);
    // A write never rides the read's ?token=.
    expect((await postJson(opened.origin, `/api/work-view/conversations/continue?token=${TOKEN}`, message)).status).toBe(401);
    expect((await pressStop(opened.origin, conversation)).status).toBe(401);
    expect((await readConversation(opened.origin, 'claude', CLAUDE_SESSION)).status).toBe(401);
    expect(opened.calls).toHaveLength(0);
    expect(opened.detectCalls()).toBe(0);

    const sent = await sendMessage(opened.origin, message, withToken);
    expect(sent.status).toBe(202);
    expect(opened.calls).toHaveLength(1);
    // The page's fetch sends the header; a read may also carry ?token=, which the read's query check lets through.
    expect((await readConversation(opened.origin, 'claude', CLAUDE_SESSION, withToken)).status).toBe(200);
    const readWithQueryToken = await fetch(`${opened.origin}/api/work-view/conversations/continuation?platform=claude&conversationSessionId=${CLAUDE_SESSION}&token=${TOKEN}`);
    expect(readWithQueryToken.status).toBe(200);
    expect((await readWithQueryToken.json()).exchanges.map((exchange: ConversationContinuation) => exchange.state)).toEqual(['running']);
    expect((await pressStop(opened.origin, conversation, withToken)).status).toBe(200);
    opened.calls[0].child.exit(0);
    await opened.nextEnded();
  });
});
