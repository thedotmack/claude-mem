// Continuing a conversation from My Work, through the worker's routes: the guards on each route, the request checks, the
// 202 and the live event every open window hears, one turn per conversation, the read of where a turn would run and of
// what was sent, and local API token mode. Every CLI is a fake spawn, so nothing runs and nothing is spent. The lookup is
// a real SessionStore (the one worker-service.ts wires in) and the folders are real, all under the repo's gitignored
// .scratch/test-runs.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { spawn as spawnRealProcess, type ChildProcess, type spawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import express from 'express';
import { listenOnEphemeralPort } from '../../../helpers/ephemeral-port.js';
import { scratchDir } from '../../../helpers/scratch-dir.js';
import { isRunning, nonCollectingParentAndZombieWrittenTo, pidWrittenTo, stateAndProcessGroupOf } from '../../../helpers/stand-in-process.js';
import { removeTempDir } from '../../../helpers/temp-dir.js';
import type { UsableAgent, UsableAgentId } from '../../../../src/services/agent-runner/detect.js';
import {
  performGracefulShutdown, type CloseableDatabase, type ShutdownableService, type StoppableService,
} from '../../../../src/services/infrastructure/GracefulShutdown.js';
import { Server } from '../../../../src/services/server/Server.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { ConversationContinuationRunner } from '../../../../src/services/work-view/conversation-continuation-runner.js';
import { WorkViewRoutes, workViewLoopbackOnly } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { runShutdownSequence, WORKER_GRACEFUL_SHUTDOWN_DEADLINE_BASE_MS } from '../../../../src/services/worker-shutdown.js';
import type { ConversationContinuation, ConversationContinuationNotice } from '../../../../src/shared/conversation-continuation.js';
import { LOCAL_API_TOKEN_HEADER } from '../../../../src/shared/local-api-token.js';
import { getSupervisor } from '../../../../src/supervisor/index.js';
import { createProcessRegistry } from '../../../../src/supervisor/process-registry.js';
import { runShutdownCascade } from '../../../../src/supervisor/shutdown.js';

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
/** Ids the page makes for clicks on "Open in Claude" (crypto.randomUUID): one per click. */
const FIRST_CLICK = '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
const SECOND_CLICK = '2c3d4e5f-6071-4b8c-9dae-1f2a3b4c5d6e';
const NOTHING_OPENING_FOR_THAT_CLICK = 'Nothing that click started is still opening this conversation in its app.';

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
  private heardFirstStop!: (signal: string) => void;
  /** The signal of the first stop sent to it (see hearStop). */
  readonly firstStop = new Promise<string>(resolve => { this.heardFirstStop = resolve; });
  /** The signal of every stop sent to it, in order. */
  readonly stopsHeard: string[] = [];
  /** Set by a test to make a stop sent to its process group fail with it, as kill(2) can (the process.kill stub below). */
  stopCannotBeSent?: Error;
  /** Hears a stop: runCommand's signal to its process group (the process.kill stub below), or Node's `signal` option on Windows. */
  hearStop(signal: string): void { this.stopsHeard.push(signal); this.heardFirstStop(signal); }
  hasExited = false;
  /** Exits with `exitCode`, or by a signal when it is null. */
  exit(exitCode: number | null, output: { stdout?: string } = {}): void {
    if (output.stdout) this.stdout.emit('data', output.stdout);
    this.hasExited = true;
    this.emit('close', exitCode);
  }
}

/** Each fake child by the process group it leads, so the process.kill stub can tell it about a stop. */
const childrenByProcessGroup = new Map<number, FakeChild>();

interface SpawnCall { command: string; args: string[]; options: SpawnOptions; child: FakeChild }

/** What detection answers about each CLI on the test's computer: Claude Code and Codex installed and logged in. */
const usableAgent = (agentId: UsableAgentId): UsableAgent => ({
  'claude-code': { id: 'claude-code', path: '/usr/local/bin/claude', authenticated: true, reason: 'test login' },
  codex: { id: 'codex', path: '/usr/local/bin/codex', authenticated: true, reason: 'test login' },
  gemini: { id: 'gemini', path: null, authenticated: false, reason: 'not installed' },
} satisfies Record<UsableAgentId, UsableAgent>)[agentId];

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

/**
 * A runner over the real SessionStore lookup and a fake spawn, wired to the routes the way worker-service.ts wires it, on
 * macOS unless `operatingSystem` says otherwise: the one system the worker opens a conversation in its app on.
 */
function runnerFor(routes: () => WorkViewRoutes, operatingSystem: NodeJS.Platform = 'darwin') {
  const calls: SpawnCall[] = [];
  let detectCalls = 0;
  const unread: ConversationContinuation[] = [];
  const waiting: Array<(exchange: ConversationContinuation) => void> = [];
  /** Who waits for the spawn at each index of `calls`. */
  const spawnWaiters = new Map<number, Array<(call: SpawnCall) => void>>();
  const runner = new ConversationContinuationRunner({
    recordedFolderForConversation: (platform, conversationSessionId) => store.getRecordedFolderForConversation(platform, conversationSessionId),
    detectAgent: async agentId => { detectCalls += 1; return usableAgent(agentId); },
    spawnImpl: ((command: string, args: string[], options: SpawnOptions) => {
      const call: SpawnCall = { command, args, options, child: new FakeChild() };
      calls.push(call);
      childrenByProcessGroup.set(call.child.pid, call.child);
      options.signal?.addEventListener('abort', () => {
        call.child.hearStop(String(options.killSignal));
        call.child.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
      }, { once: true });
      for (const waiter of spawnWaiters.get(calls.length - 1) ?? []) waiter(call);
      spawnWaiters.delete(calls.length - 1);
      return call.child;
    }) as unknown as typeof spawn,
    onChange: exchange => {
      routes().publishConversationContinuation(exchange);
      const waiter = waiting.shift();
      if (waiter) waiter(exchange); else unread.push(exchange);
    },
    operatingSystem: () => operatingSystem,
  });
  return {
    runner,
    calls,
    detectCalls: () => detectCalls,
    /** The next exchange the runner reports as ended. */
    nextEnded: () => unread.length > 0 ? Promise.resolve(unread.shift()!) : new Promise<ConversationContinuation>(resolve => waiting.push(resolve)),
    /** The spawn at `index` of `calls`, once it has happened: an open in the app answers only after its command exits. */
    spawnedCall: (index: number) => calls[index] ? Promise.resolve(calls[index]) : new Promise<SpawnCall>(resolve => {
      spawnWaiters.set(index, [...(spawnWaiters.get(index) ?? []), resolve]);
    }),
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
async function startRoutes({ withRunner = true, localApiToken, operatingSystem }: {
  withRunner?: boolean; localApiToken?: string; operatingSystem?: NodeJS.Platform;
} = {}): Promise<RoutesUnderTest> {
  let routes!: WorkViewRoutes;
  const turns = runnerFor(() => routes, operatingSystem);
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
const pressOpenInApp = (origin: string, body: unknown, headers?: Record<string, string>) => postJson(origin, '/api/work-view/conversations/open-in-app', body, headers);
const pressStopOpening = (origin: string, body: unknown, headers?: Record<string, string>) => postJson(origin, '/api/work-view/conversations/open-in-app/stop', body, headers);
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
      expect((await pressOpenInApp(opened.origin, conversation, headers)).status).toBe(403);
      expect((await pressStopOpening(opened.origin, conversation, headers)).status).toBe(403);
    }
    for (const path of ['/api/work-view/conversations/continue', '/api/work-view/conversations/stop', '/api/work-view/conversations/open-in-app',
      '/api/work-view/conversations/open-in-app/stop']) {
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
    for (const body of [
      { platform: 'claude', conversationSessionId: NON_UUID_CLAUDE_SESSION, openInAppClickId: FIRST_CLICK },
      { platform: 'gemini', conversationSessionId: CLAUDE_SESSION, openInAppClickId: FIRST_CLICK },
      { platform: 'claude', conversationSessionId: CLAUDE_SESSION, openInAppClickId: FIRST_CLICK, ownerMessage: 'Which word?' },
    ]) {
      const openWithoutConversation = await pressOpenInApp(opened.origin, body);
      expect(openWithoutConversation.status).toBe(400);
      expect((await openWithoutConversation.json()).error).toBe('ValidationError');
      const stopOpeningWithoutConversation = await pressStopOpening(opened.origin, body);
      expect(stopOpeningWithoutConversation.status).toBe(400);
      expect((await stopOpeningWithoutConversation.json()).error).toBe('ValidationError');
    }
    expect(opened.calls).toHaveLength(0);
    expect(opened.detectCalls()).toBe(0);
  });

  it("answers an open in the app, and its stop, that names no click, or a click id that is not the page's random UUID, with validateBody 400s, and runs nothing", async () => {
    const opened = await startRoutes();
    const conversation = { platform: 'claude', conversationSessionId: CLAUDE_SESSION };
    const clickIdsRefused: unknown[] = [
      undefined,
      '',
      FIRST_CLICK.toUpperCase(),
      // A UUID, but not one crypto.randomUUID makes (version 1).
      '1b2c3d4e-5f60-1a7b-8c9d-0e1f2a3b4c5d',
      `${FIRST_CLICK} `,
      'the-same-click',
      42,
    ];
    for (const openInAppClickId of clickIdsRefused) {
      const body = openInAppClickId === undefined ? conversation : { ...conversation, openInAppClickId };
      for (const press of [pressOpenInApp, pressStopOpening]) {
        const response = await press(opened.origin, body);
        expect(response.status).toBe(400);
        const answer = await response.json() as { error: string; issues: Array<{ path: unknown[] }> };
        expect(answer.error).toBe('ValidationError');
        expect(answer.issues.some(issue => issue.path[0] === 'openInAppClickId')).toBe(true);
      }
    }
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
      await pressOpenInApp(opened.origin, { ...conversation, openInAppClickId: FIRST_CLICK }),
      await pressStopOpening(opened.origin, { ...conversation, openInAppClickId: FIRST_CLICK }),
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

  // A stop goes wrong this way only in the process-group signal macOS and Linux get (CommandOptions.signal in detect.ts).
  (process.platform === 'win32' ? it.skip : it)('answers a Stop that could not be sent with 409 and the sentence saying so, and the turn runs on', async () => {
    const opened = await startRoutes();
    const conversation = { platform: 'claude', conversationSessionId: CLAUDE_SESSION };
    expect((await sendMessage(opened.origin, { ...conversation, ownerMessage: 'Count slowly to 200, one number per line.' })).status).toBe(202);
    const turnProcessGroup = opened.calls[0].child.pid;
    const realProcessKill = process.kill.bind(process);
    // kill(2)'s answer when no process in the group may be signalled, as Node's process.kill throws it.
    const notPermitted = Object.assign(new Error('kill EPERM'), { code: 'EPERM', errno: -1, syscall: 'kill' });
    const processKill = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === -turnProcessGroup) throw notPermitted;
      return realProcessKill(pid, signal);
    }) as typeof process.kill);
    let stopped: Response;
    try {
      stopped = await pressStop(opened.origin, conversation);
    } finally {
      processKill.mockRestore();
    }
    expect(stopped.status).toBe(409);
    expect(await stopped.json()).toEqual({ error: 'The stop did not reach Claude Code (kill EPERM), so this turn is still running.' });
    const read = async () => (await (await readConversation(opened.origin, 'claude', CLAUDE_SESSION)).json() as { exchanges: ConversationContinuation[] }).exchanges;
    expect((await read()).map(exchange => exchange.state)).toEqual(['running']);
    // The turn then finishes by itself: its reply stands, as a turn no stop reached.
    opened.calls[0].child.exit(0, { stdout: claudeOutput('1\n2\n3') });
    expect(await opened.nextEnded()).toMatchObject({ state: 'replied', replyText: '1\n2\n3' });
    expect((await read()).map(({ state, replyText }) => ({ state, replyText }))).toEqual([{ state: 'replied', replyText: '1\n2\n3' }]);
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
      target: { canContinue: true, recordedFolder: folderPresent, runsInFolder: folderPresent, recordedFolderIsGone: false, opensInAppNamed: 'Claude' }, exchanges: [],
    });
    expect(await read('codex', CODEX_SESSION)).toEqual({
      target: { canContinue: true, recordedFolder: deletedRecordedFolder, runsInFolder: fileFolder, recordedFolderIsGone: true, opensInAppNamed: null }, exchanges: [],
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

describe('opening a conversation in its app', () => {
  const OPENED_LINE = `Opening session ${CLAUDE_SESSION} in Claude Desktop`;
  const STILL_OPENING = 'Claude Code is still opening this conversation in the Claude app from an earlier click. Wait for it to finish, or reload the page you clicked it in to stop it.';
  /** How the runner runs `claude --desktop --resume <id>`: under script, which gives it the terminal it needs. */
  const openInAppCommand = (conversationSessionId: string) =>
    ({ command: '/usr/bin/script', args: ['-q', '/dev/null', '/usr/local/bin/claude', '--desktop', '--resume', conversationSessionId] });

  // runCommand stops a command on macOS and Linux by signalling its process group: this tells the fake child instead.
  let restoreProcessKill = () => {};
  beforeEach(() => {
    const realProcessKill = process.kill.bind(process);
    const processKill = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      const child = pid < 0 ? childrenByProcessGroup.get(-pid) : undefined;
      if (!child) return realProcessKill(pid, signal);
      // Signal 0 asks whether any process is left in the group, which runCommand does once the command has exited. The
      // fake child is alone in its group: once it has exited, kill(2) answers ESRCH, as Node's process.kill throws it.
      if (child.hasExited) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH', errno: -3, syscall: 'kill' });
      if (signal === 0) return true;
      if (child.stopCannotBeSent) throw child.stopCannotBeSent;
      child.hearStop(String(signal));
      return true;
    }) as typeof process.kill);
    restoreProcessKill = () => processKill.mockRestore();
  });
  afterEach(() => {
    restoreProcessKill();
    childrenByProcessGroup.clear();
  });

  it('answers 200 with what `claude --desktop --resume` printed once it has exited 0, run in the folder its turn would run in, and starts no turn', async () => {
    const opened = await startRoutes();
    const answer = pressOpenInApp(opened.origin, { platform: 'claude', conversationSessionId: CLAUDE_SESSION, openInAppClickId: FIRST_CLICK });
    const call = await opened.spawnedCall(0);
    expect({ command: call.command, args: call.args }).toEqual(openInAppCommand(CLAUDE_SESSION));
    expect(call.options.cwd).toBe(folderPresent);
    expect(call.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(call.child.stdinText).toBeNull();
    call.child.exit(0, { stdout: `^D\b\b\u001b[0m${OPENED_LINE}\r\n\u001b[?25h` });
    const response = await answer;
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ printedText: OPENED_LINE });
    expect((await (await readConversation(opened.origin, 'claude', CLAUDE_SESSION)).json()).exchanges).toEqual([]);
    expect(opened.calls).toHaveLength(1);
  });

  it('answers 409 with one sentence and everything the CLI printed when the app did not open it', async () => {
    const opened = await startRoutes();
    const answer = pressOpenInApp(opened.origin, { platform: 'claude', conversationSessionId: CLAUDE_SESSION, openInAppClickId: FIRST_CLICK });
    (await opened.spawnedCall(0)).child.exit(1, { stdout: 'Claude Desktop is not installed. Install it from https://claude.ai/download\n' });
    const response = await answer;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Claude Code could not open this conversation in the Claude app. Claude Code exited with code 1.\n\nClaude Desktop is not installed. Install it from https://claude.ai/download',
    });
  });

  it('refuses a second open of the same conversation while the first runs, with 409 and one sentence, and runs one command', async () => {
    const opened = await startRoutes();
    const conversation = { platform: 'claude', conversationSessionId: CLAUDE_SESSION };
    const first = pressOpenInApp(opened.origin, { ...conversation, openInAppClickId: FIRST_CLICK });
    const call = await opened.spawnedCall(0);
    // As from a second tab, or this one after the drawer was closed and opened again.
    const second = await pressOpenInApp(opened.origin, { ...conversation, openInAppClickId: SECOND_CLICK });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: STILL_OPENING });
    expect(opened.calls).toHaveLength(1);
    call.child.exit(0, { stdout: '^D\b\b' });
    const firstAnswer = await first;
    expect(firstAnswer.status).toBe(200);
    expect(await firstAnswer.json()).toEqual({ printedText: null });
  });

  it("stops the open's command when the page that asked says it is going away, and opens the conversation again on the next click", async () => {
    const opened = await startRoutes();
    const conversation = { platform: 'claude', conversationSessionId: CLAUDE_SESSION };
    const nothingOpening = await pressStopOpening(opened.origin, { ...conversation, openInAppClickId: FIRST_CLICK });
    expect(nothingOpening.status).toBe(409);
    expect(await nothingOpening.json()).toEqual({ error: NOTHING_OPENING_FOR_THAT_CLICK });

    const abandoned = pressOpenInApp(opened.origin, { ...conversation, openInAppClickId: FIRST_CLICK });
    const call = await opened.spawnedCall(0);
    // What the page sends from 'pagehide' while its open still runs (local-source.ts): the same click's id.
    const stopping = await pressStopOpening(opened.origin, { ...conversation, openInAppClickId: FIRST_CLICK });
    expect(stopping.status).toBe(200);
    expect(stopping.headers.get('cache-control')).toBe('no-store');
    expect(await stopping.json()).toEqual({});
    expect(await call.child.firstStop).toBe('SIGTERM');
    call.child.exit(null);
    const abandonedAnswer = await abandoned;
    expect(abandonedAnswer.status).toBe(409);
    expect(await abandonedAnswer.json()).toEqual({
      error: 'Claude Code could not open this conversation in the Claude app: the page that asked went away, so it was stopped.',
    });

    const answer = pressOpenInApp(opened.origin, { ...conversation, openInAppClickId: SECOND_CLICK });
    (await opened.spawnedCall(1)).child.exit(0, { stdout: `^D\b\b${OPENED_LINE}\r\n` });
    const response = await answer;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ printedText: OPENED_LINE });
    expect(opened.calls).toHaveLength(2);
  });

  it("refuses with 409 and one sentence the stop for another click, from another tab or late from an earlier click, and the open runs on", async () => {
    const opened = await startRoutes();
    const conversation = { platform: 'claude', conversationSessionId: CLAUDE_SESSION };
    const fromTabA = pressOpenInApp(opened.origin, { ...conversation, openInAppClickId: FIRST_CLICK });
    const call = await opened.spawnedCall(0);
    // Tab B's click is refused while tab A's open runs, and tab B closes before its refusal comes: it sends its own stop.
    expect((await pressOpenInApp(opened.origin, { ...conversation, openInAppClickId: SECOND_CLICK })).status).toBe(409);
    const stopFromTabB = await pressStopOpening(opened.origin, { ...conversation, openInAppClickId: SECOND_CLICK });
    expect(stopFromTabB.status).toBe(409);
    expect(await stopFromTabB.json()).toEqual({ error: NOTHING_OPENING_FOR_THAT_CLICK });
    expect(call.child.stopsHeard).toEqual([]);
    call.child.exit(0, { stdout: `^D\b\b${OPENED_LINE}\r\n` });
    const answerToTabA = await fromTabA;
    expect(answerToTabA.status).toBe(200);
    expect(await answerToTabA.json()).toEqual({ printedText: OPENED_LINE });

    // A newer click opens it again, and the stop tab A's page sent as it went away comes late.
    const newer = pressOpenInApp(opened.origin, { ...conversation, openInAppClickId: SECOND_CLICK });
    const newerCall = await opened.spawnedCall(1);
    const lateStop = await pressStopOpening(opened.origin, { ...conversation, openInAppClickId: FIRST_CLICK });
    expect(lateStop.status).toBe(409);
    expect(await lateStop.json()).toEqual({ error: NOTHING_OPENING_FOR_THAT_CLICK });
    expect(newerCall.child.stopsHeard).toEqual([]);
    newerCall.child.exit(0);
    expect((await newer).status).toBe(200);
    expect(opened.calls).toHaveLength(2);
  });

  // A stop goes wrong only in the process-group signal macOS and Linux get (CommandOptions.signal in detect.ts).
  (process.platform === 'win32' ? it.skip : it)('answers a stop it could not send with 409 and the error in one sentence, not 200, and the open runs on', async () => {
    const opened = await startRoutes();
    const clickedOpen = { platform: 'claude', conversationSessionId: CLAUDE_SESSION, openInAppClickId: FIRST_CLICK };
    const answer = pressOpenInApp(opened.origin, clickedOpen);
    const call = await opened.spawnedCall(0);
    // kill(2)'s answer when no process in the group may be signalled, as Node's process.kill throws it.
    call.child.stopCannotBeSent = Object.assign(new Error('kill EPERM'), { code: 'EPERM', errno: -1, syscall: 'kill' });
    const stopping = await pressStopOpening(opened.origin, clickedOpen);
    expect(stopping.status).toBe(409);
    expect(await stopping.json()).toEqual({
      error: 'The stop did not reach Claude Code (kill EPERM), so it is still opening this conversation in the Claude app.',
    });
    expect(call.child.stopsHeard).toEqual([]);
    // Its end is its own: it opened the conversation.
    call.child.exit(0, { stdout: `^D\b\b${OPENED_LINE}\r\n` });
    const response = await answer;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ printedText: OPENED_LINE });
  });

  it('on Windows and Linux, reads that no app opens the conversation here, and refuses an open with 409, running nothing', async () => {
    for (const operatingSystem of ['win32', 'linux'] as const) {
      const opened = await startRoutes({ operatingSystem });
      const { target } = await (await readConversation(opened.origin, 'claude', CLAUDE_SESSION)).json();
      expect(target).toEqual({ canContinue: true, recordedFolder: folderPresent, runsInFolder: folderPresent, recordedFolderIsGone: false, opensInAppNamed: null });
      const response = await pressOpenInApp(opened.origin, { platform: 'claude', conversationSessionId: CLAUDE_SESSION, openInAppClickId: FIRST_CLICK });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'Claude Code opens a conversation in the Claude app from here only on macOS. Copy the resume command instead.' });
      expect(opened.calls).toHaveLength(0);
      expect(opened.detectCalls()).toBe(0);
    }
  });

  it("refuses a Codex conversation, and one it can't continue, with 409 and its sentence, and runs nothing", async () => {
    const opened = await startRoutes();
    const refusals: Array<[string, string, string]> = [
      ['codex', CODEX_SESSION, 'Codex has no documented way to open a conversation in its app. Copy the resume command instead.'],
      ['claude', CLAUDE_SESSION_WITHOUT_FOLDER, 'No folder was recorded for this Claude Code conversation, so it can’t be continued from here.'],
    ];
    for (const [platform, conversationSessionId, sentence] of refusals) {
      const response = await pressOpenInApp(opened.origin, { platform, conversationSessionId, openInAppClickId: FIRST_CLICK });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: sentence });
    }
    expect(opened.calls).toHaveLength(0);
    expect(opened.detectCalls()).toBe(0);
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

  it('refuses an open in the app without the token with 401 and runs nothing; with the token it runs', async () => {
    const TOKEN = 'conversation-open-in-app-routes-test-token';
    const opened = await startRoutes({ localApiToken: TOKEN });
    const clickedOpen = { platform: 'claude', conversationSessionId: CLAUDE_SESSION, openInAppClickId: FIRST_CLICK };
    expect((await pressOpenInApp(opened.origin, clickedOpen)).status).toBe(401);
    expect((await pressOpenInApp(opened.origin, clickedOpen, { [LOCAL_API_TOKEN_HEADER]: 'not-the-token' })).status).toBe(401);
    expect((await postJson(opened.origin, `/api/work-view/conversations/open-in-app?token=${TOKEN}`, clickedOpen)).status).toBe(401);
    expect((await pressStopOpening(opened.origin, clickedOpen)).status).toBe(401);
    expect(opened.calls).toHaveLength(0);
    expect(opened.detectCalls()).toBe(0);

    const answer = pressOpenInApp(opened.origin, clickedOpen, { [LOCAL_API_TOKEN_HEADER]: TOKEN });
    (await opened.spawnedCall(0)).child.exit(0);
    expect((await answer).status).toBe(200);
    expect(opened.calls).toHaveLength(1);
    // With the token, a stop reaches the route, which answers that nothing that click started is opening the conversation any more.
    const stopWithToken = await pressStopOpening(opened.origin, clickedOpen, { [LOCAL_API_TOKEN_HEADER]: TOKEN });
    expect(stopWithToken.status).toBe(409);
    expect(await stopWithToken.json()).toEqual({ error: NOTHING_OPENING_FOR_THAT_CLICK });
  });
});

describe('when the worker shuts down, with a real turn running', () => {
  const STAND_IN_TURN = join(FIXTURES, 'cli-turn-that-ends-a-moment-after-its-stop.sh');
  const STAND_IN_TURN_THAT_IGNORES_ITS_STOP = join(FIXTURES, 'cli-turn-that-ignores-its-stop.sh');
  const STAND_IN_TURN_THAT_IGNORES_SIGINT = join(FIXTURES, 'cli-turn-that-ignores-sigint.sh');
  const LAUNCHER_THAT_EXITS_BEFORE_ITS_CLI = join(FIXTURES, 'launcher-that-exits-before-its-cli.mjs');
  const STOPPED_BY_THE_WORKER = 'The worker shut down, so it stopped this turn.';
  const SHUTTING_DOWN = 'The worker is shutting down, so this message was not sent. Send it again once My Work reconnects.';
  // On Windows a stop goes to the command alone and there is no sh (CommandOptions.signal in detect.ts).
  const itOnMacOsAndLinux = process.platform === 'win32' ? it.skip : it;

  /**
   * The process groups the tests started: each command the runner starts leads one (CommandOptions.signal in detect.ts),
   * with everything it started in it. Ended after each test in case it failed before the shutdown did.
   */
  const processGroupsStarted: number[] = [];
  afterEach(() => {
    for (const processGroup of processGroupsStarted.splice(0)) if (isRunning(-processGroup)) process.kill(-processGroup, 'SIGKILL');
  });

  /**
   * A runner wired as worker-service.ts wires it, over the real SessionStore lookup, whose CLI is the real process `cli`,
   * inside routes, with its own copy of the supervisor's registry. With `launcherInFront`, the command the runner starts
   * is the launcher that exits before the CLI it starts (launcher-that-exits-before-its-cli.mjs), running `cli`; with
   * `cliOutputGoesElsewhere`, the CLI writes to a file, not to the output the launcher was started with. Starts one turn,
   * and answers once the CLI has written its pid.
   */
  async function realTurnRunning(cli: string, launcherInFront?: { cliOutputGoesElsewhere: boolean }) {
    const folder = join(fileFolder, `shutdown-${++testFolderCount}`);
    mkdirSync(folder);
    const pidFile = join(folder, 'stand-in-turn.pid');
    // The supervisor's registry, as worker-service.ts passes it (getSupervisor().getRegistry()), in this test's folder.
    const registry = createProcessRegistry(join(folder, 'supervisor.json'));
    /** Each command the runner started, and its 'close', heard once everything runCommand does on it has run. */
    const spawned: Array<{ child: ChildProcess; closed: Promise<void> }> = [];
    const unread: ConversationContinuation[] = [];
    const waiting: Array<(exchange: ConversationContinuation) => void> = [];
    let routes!: WorkViewRoutes;
    const runner = new ConversationContinuationRunner({
      recordedFolderForConversation: (platform, conversationSessionId) => store.getRecordedFolderForConversation(platform, conversationSessionId),
      detectAgent: async agentId => ({ id: agentId, path: launcherInFront ? LAUNCHER_THAT_EXITS_BEFORE_ITS_CLI : cli, authenticated: true, reason: 'test login' }),
      spawnImpl: ((command: string, args: string[], options: SpawnOptions) => {
        const child = spawnRealProcess(command, args, options);
        processGroupsStarted.push(child.pid!);
        // Heard before runCommand's own 'close' listener, and settled once everything that one does has run.
        spawned.push({ child, closed: new Promise<void>(resolve => child.once('close', () => setImmediate(resolve))) });
        return child;
      }) as unknown as typeof spawn,
      onChange: exchange => {
        routes.publishConversationContinuation(exchange);
        const waiter = waiting.shift();
        if (waiter) waiter(exchange); else unread.push(exchange);
      },
      environment: () => ({
        PATH: process.env.PATH, HOME: process.env.HOME, STAND_IN_TURN_WRITES_ITS_PID_TO: pidFile,
        ...(launcherInFront ? { STAND_IN_LAUNCHER_RUNS: cli } : {}),
        ...(launcherInFront?.cliOutputGoesElsewhere ? { STAND_IN_LAUNCHER_SENDS_CLI_OUTPUT_TO: join(folder, 'cli-output.log') } : {}),
      }),
      processRegistry: registry,
    });
    routes = new WorkViewRoutes({ ...isolatedRoutesOptions(), conversationContinuationRunner: runner });

    expect(await runner.start('claude', CLAUDE_SESSION, 'Count slowly to 200, one number per line.')).toHaveProperty('exchange');
    const standInPid = await pidWrittenTo(pidFile);
    expect(isRunning(standInPid)).toBe(true);
    return {
      folder, pidFile, registry, runner, routes, standInPid, spawned,
      /** The next exchange the runner reports as ended. */
      nextEnded: () => unread.length > 0 ? Promise.resolve(unread.shift()!) : new Promise<ConversationContinuation>(resolve => waiting.push(resolve)),
    };
  }
  type RealTurn = Awaited<ReturnType<typeof realTurnRunning>>;

  /**
   * The supervisor's shutdown cascade over `turn`'s copy of the registry, for the two places the worker calls
   * getSupervisor().stop(): the graceful shutdown's last step (each test puts this in place of the real one, which would
   * stop what other tests in this process registered with it) and runShutdownSequence's stopEveryRegisteredChildProcess.
   * As Supervisor.stop does, a call while a cascade runs waits for that one, and spawnDaemon is refused while one runs
   * (Supervisor.assertCanSpawn).
   */
  function supervisorFor(turn: RealTurn, onCascadeBegins: () => void) {
    let cascadeRunning: Promise<void> | null = null;
    const stop = (): Promise<void> => {
      if (cascadeRunning) return cascadeRunning;
      onCascadeBegins();
      cascadeRunning = runShutdownCascade({ registry: turn.registry, currentPid: process.pid, pidFilePath: join(turn.folder, 'worker.pid') })
        .finally(() => { cascadeRunning = null; });
      return cascadeRunning;
    };
    return { stop, isRunningItsCascade: () => cascadeRunning !== null };
  }

  /**
   * runShutdownSequence as WorkerService.shutdown runs it, for `turn`: its first step closes the routes, which sends the
   * turn its stop; then the real performGracefulShutdown, with no HTTP server, the given session drain, Chroma and
   * database steps, and the supervisor's cascade (supervisorFor, in place of getSupervisor().stop while it runs), under
   * `gracefulDeadlineMs`; then the runner's force stop, and the cascade again when the graceful shutdown did not finish.
   * A signal's shutdown starts no successor; a restart's spawns one, refused while the cascade runs, as spawnDaemon is.
   */
  async function runWorkerShutdown(turn: RealTurn, {
    reason = 'signal', gracefulDeadlineMs, sessionManager, chromaMcpManager, dbManager, successor = [], onSupervisorCascadeBegins = () => {},
  }: {
    reason?: 'signal' | 'restart';
    gracefulDeadlineMs: number;
    sessionManager: ShutdownableService;
    chromaMcpManager?: StoppableService;
    dbManager?: CloseableDatabase;
    /** What became of the successor a restart spawns. */
    successor?: string[];
    /** Told as each run of the supervisor's cascade begins. */
    onSupervisorCascadeBegins?: () => void;
  }): Promise<void> {
    const supervisor = supervisorFor(turn, onSupervisorCascadeBegins);
    const supervisorStop = spyOn(getSupervisor(), 'stop').mockImplementation(supervisor.stop);
    let shuttingDown = false;
    const noSuccessor = () => { throw new Error('A shutdown on a signal starts no successor.'); };
    try {
      await runShutdownSequence({
        reason,
        isShuttingDown: () => shuttingDown,
        markShuttingDown: () => { shuttingDown = true; },
        beforeGracefulShutdown: async () => { turn.routes.close(); },
        performGracefulShutdown: () => performGracefulShutdown({
          server: null, commandsStoppedAsShutdownBegan: turn.runner, sessionManager, chromaMcpManager, dbManager,
        }),
        gracefulDeadlineMs,
        forceStopCommandsStillRunning: () => turn.runner.forceStopCommandsStillRunning(),
        stopEveryRegisteredChildProcess: supervisor.stop,
        restartHandoff: reason === 'restart' ? {
          port: 0, portFreeTimeoutMs: 0, resolveSuccessorScript: () => 'worker-service.cjs', waitForPortFree: async () => true, removePidFile: () => {},
          spawnDaemon: () => {
            if (supervisor.isRunningItsCascade()) {
              successor.push('refused: the supervisor is shutting down');
              return undefined;
            }
            successor.push('spawned');
            return 1;
          },
        } : {
          port: 0, portFreeTimeoutMs: 0, resolveSuccessorScript: noSuccessor, waitForPortFree: noSuccessor, removePidFile: noSuccessor, spawnDaemon: noSuccessor,
        },
      });
    } finally {
      supervisorStop.mockRestore();
    }
  }

  itOnMacOsAndLinux('stops the turn and waits for its CLI to exit before the shutdown finishes, and sends it nowhere again', async () => {
    const turn = await realTurnRunning(STAND_IN_TURN);

    // The supervisor's cascade, the graceful shutdown's last step, stops whatever is still in the registry and waits for
    // it. The worker gives up its PID file, and on a restart starts its successor, only after that.
    turn.routes.close();
    await runShutdownCascade({ registry: turn.registry, currentPid: process.pid, pidFilePath: join(turn.folder, 'worker.pid') });
    // The stand-in ends a moment after its stop, so a shutdown that did not wait for it would be done while it still ran.
    expect(isRunning(turn.standInPid)).toBe(false);
    expect(turn.registry.getAll()).toEqual([]);
    const stopped = await turn.nextEnded();
    expect(stopped.state).toBe('failed');
    // Then whatever the stand-in's shell printed, kept whole: "Terminated: 15" when the cascade's SIGTERM cut a nap short.
    expect(stopped.failureText).toStartWith(STOPPED_BY_THE_WORKER);

    // Nothing sends it again, and nothing new starts.
    expect(await turn.runner.start('claude', CLAUDE_SESSION, 'Count slowly to 200, one number per line.')).toEqual({ refusalText: SHUTTING_DOWN });
    expect(turn.spawned).toHaveLength(1);
  });

  itOnMacOsAndLinux("starts the session drain and the other steps at once while the turn ends on its stop, and the supervisor's cascade only once it has", async () => {
    const turn = await realTurnRunning(STAND_IN_TURN);
    const steps: string[] = [];
    let standInRanWhenTheSessionDrainBegan: boolean | undefined;
    let standInRanWhenTheCascadeBegan: boolean | undefined;
    await runWorkerShutdown(turn, {
      gracefulDeadlineMs: WORKER_GRACEFUL_SHUTDOWN_DEADLINE_BASE_MS,
      sessionManager: { shutdownAll: async () => { standInRanWhenTheSessionDrainBegan = isRunning(turn.standInPid); steps.push('session drain'); } },
      chromaMcpManager: { stop: async () => { steps.push('Chroma stop'); } },
      dbManager: { close: async () => { steps.push('database close'); } },
      onSupervisorCascadeBegins: () => { standInRanWhenTheCascadeBegan = isRunning(turn.standInPid); steps.push('supervisor cascade'); },
    });
    // The stand-in ends a moment after its stop. The session drain, Chroma and the database did not wait for it; the
    // supervisor's cascade, whose SIGTERM would cut a turn short, did. It ran once: the graceful shutdown finished.
    expect(standInRanWhenTheSessionDrainBegan).toBe(true);
    expect(standInRanWhenTheCascadeBegan).toBe(false);
    expect(steps).toEqual(['session drain', 'Chroma stop', 'database close', 'supervisor cascade']);
    expect(isRunning(-turn.standInPid)).toBe(false);
    const stopped = await turn.nextEnded();
    expect(stopped.state).toBe('failed');
    expect(stopped.failureText).toStartWith(STOPPED_BY_THE_WORKER);
    expect(turn.spawned).toHaveLength(1);
  });

  /**
   * The stand-in ignores SIGTERM too, so the force stop's escalation runs whole before the shutdown returns: the cascade's
   * 5 s grace window after SIGTERM, then up to 1 s after SIGKILL (terminateThenForceKillProcessGroups). 15 s leaves room
   * for a slow machine on top of the 6 s; bun's default of 5 s would end the test inside that grace window.
   */
  const ESCALATION_RUNS_WHOLE_TIMEOUT_MS = 15_000;

  itOnMacOsAndLinux('ends a turn whose CLI ignores its stop before the worker exits, even when the graceful shutdown runs out of its deadline', async () => {
    const turn = await realTurnRunning(STAND_IN_TURN_THAT_IGNORES_ITS_STOP);
    // As a session drain that lasts longer than the deadline, as one has been seen to. The deadline is short only so the
    // test is: the turn outlasts any deadline.
    await runWorkerShutdown(turn, { sessionManager: { shutdownAll: () => new Promise<void>(() => {}) }, gracefulDeadlineMs: 300 });

    // runShutdownSequence has returned, so the worker would call process.exit now: the turn's CLI, and the naps in its
    // process group, are gone by then.
    expect(isRunning(turn.standInPid)).toBe(false);
    expect(isRunning(-turn.standInPid)).toBe(false);
    const stopped = await turn.nextEnded();
    expect(stopped.state).toBe('failed');
    expect(stopped.failureText).toStartWith(STOPPED_BY_THE_WORKER);
    expect(turn.registry.getAll()).toEqual([]);

    // Nothing sends it again, and nothing new starts.
    expect(await turn.runner.start('claude', CLAUDE_SESSION, 'Count slowly to 200, one number per line.')).toEqual({ refusalText: SHUTTING_DOWN });
    expect(turn.spawned).toHaveLength(1);
  }, ESCALATION_RUNS_WHOLE_TIMEOUT_MS);

  itOnMacOsAndLinux("runs every other step at once beside a turn that ignores its stop, and the supervisor's cascade before the worker exits, so a restart starts its successor", async () => {
    const turn = await realTurnRunning(STAND_IN_TURN_THAT_IGNORES_SIGINT);
    // Another child of the worker's in its registry, as chroma-mcp or an observer is, which takes a moment to stop on the
    // cascade's SIGTERM. It leads a process group of its own, as the cascade's record of it says.
    const childPidFile = join(turn.folder, 'registered-child.pid');
    const registeredChild = spawnRealProcess(STAND_IN_TURN, [], {
      detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, STAND_IN_TURN_WRITES_ITS_PID_TO: childPidFile },
    });
    processGroupsStarted.push(registeredChild.pid!);
    await pidWrittenTo(childPidFile);
    turn.registry.register(`registered-child:${registeredChild.pid}`, {
      pid: registeredChild.pid!, type: 'registered-child', startedAt: new Date().toISOString(), pgid: registeredChild.pid!,
    });
    const steps: string[] = [];
    const successor: string[] = [];
    let turnRanWhenTheSessionDrainBegan: boolean | undefined;
    await runWorkerShutdown(turn, {
      reason: 'restart',
      // Short only so the test is: the turn outlasts any deadline.
      gracefulDeadlineMs: 300,
      sessionManager: { shutdownAll: async () => { turnRanWhenTheSessionDrainBegan = isRunning(turn.standInPid); steps.push('session drain'); } },
      chromaMcpManager: { stop: async () => { steps.push('Chroma stop'); } },
      dbManager: { close: async () => { steps.push('database close'); } },
      successor,
    });

    // runShutdownSequence has returned: the worker exits now, once it has started its successor. Every step had run, the
    // session drain without waiting for the turn, and nothing it started is left running.
    expect(turnRanWhenTheSessionDrainBegan).toBe(true);
    expect(steps).toEqual(['session drain', 'Chroma stop', 'database close']);
    expect(isRunning(turn.standInPid)).toBe(false);
    expect(isRunning(-registeredChild.pid!)).toBe(false);
    expect(turn.registry.getAll()).toEqual([]);
    expect(successor).toEqual(['spawned']);
    const stopped = await turn.nextEnded();
    expect(stopped.state).toBe('failed');
    expect(stopped.failureText).toStartWith(STOPPED_BY_THE_WORKER);
  });

  for (const [whereTheCliWrites, cliOutputGoesElsewhere] of [
    ['to the output the launcher was started with', false],
    ['to a file of its own', true],
  ] as const) {
    itOnMacOsAndLinux(`ends a turn whose CLI outlives its launcher on the stop before the worker exits, when the CLI writes ${whereTheCliWrites}`, async () => {
      // The launcher dies on the stop at once; the CLI behind it, in the launcher's process group, ignores it.
      const turn = await realTurnRunning(STAND_IN_TURN_THAT_IGNORES_SIGINT, { cliOutputGoesElsewhere });
      const launcherPid = turn.spawned[0].child.pid!;
      await runWorkerShutdown(turn, { sessionManager: { shutdownAll: async () => {} }, gracefulDeadlineMs: 300 });

      // runShutdownSequence has returned, so the worker would call process.exit now: the CLI and its process group are
      // gone by then.
      expect(isRunning(launcherPid)).toBe(false);
      expect(isRunning(turn.standInPid)).toBe(false);
      expect(isRunning(-launcherPid)).toBe(false);
      expect(turn.registry.getAll()).toEqual([]);
      const stopped = await turn.nextEnded();
      expect(stopped.state).toBe('failed');
      expect(stopped.failureText).toStartWith(STOPPED_BY_THE_WORKER);
      expect(await turn.runner.start('claude', CLAUDE_SESSION, 'Count slowly to 200, one number per line.')).toEqual({ refusalText: SHUTTING_DOWN });
      expect(turn.spawned).toHaveLength(1);
    });
  }

  itOnMacOsAndLinux("refuses a second Send while a stopped turn's CLI still ends its turn behind a launcher that died on the stop", async () => {
    const turn = await realTurnRunning(STAND_IN_TURN, { cliOutputGoesElsewhere: true });
    expect(turn.runner.stop('claude', CLAUDE_SESSION)).toHaveProperty('exchange');
    // The launcher died on the stop at once, and its 'close' came at once too, since the CLI's output does not reach the
    // launcher's. The CLI ends its turn six 50 ms naps after its stop, so it is still writing.
    await turn.spawned[0].closed;
    expect(isRunning(turn.standInPid)).toBe(true);
    expect(await turn.runner.start('claude', CLAUDE_SESSION, 'And now?')).toEqual({ refusalText: STILL_RUNNING_REFUSAL });

    const stopped = await turn.nextEnded();
    expect(stopped).toMatchObject({ state: 'failed', failureText: 'You stopped this turn.' });
    expect(isRunning(turn.standInPid)).toBe(false);
    // Once the CLI has ended, the conversation takes the next Send.
    rmSync(turn.pidFile);
    expect(await turn.runner.start('claude', CLAUDE_SESSION, 'And now?')).toHaveProperty('exchange');
    await pidWrittenTo(turn.pidFile);
    expect(turn.runner.stop('claude', CLAUDE_SESSION)).toHaveProperty('exchange');
    expect(await turn.nextEnded()).toMatchObject({ state: 'failed', failureText: 'You stopped this turn.' });
    expect(turn.spawned).toHaveLength(2);
  });
});

describe('a real turn whose command leaves its process group holding only a zombie', () => {
  const TURN_THAT_LEAVES_ONLY_A_ZOMBIE_IN_ITS_GROUP = join(FIXTURES, 'turn-that-leaves-only-a-zombie-in-its-group.pl');
  // On Windows a command has no process group of its own (CommandOptions.signal in detect.ts).
  const itOnMacOsAndLinux = process.platform === 'win32' ? it.skip : it;
  /** The parents that never collect their zombie: ended after each test, so that the zombie is collected. */
  const nonCollectingParents: number[] = [];
  afterEach(() => {
    for (const pid of nonCollectingParents.splice(0)) if (isRunning(pid)) process.kill(pid, 'SIGKILL');
  });

  itOnMacOsAndLinux('ends each turn with its reply as its command exits, though the zombie stays, so the next Send starts a turn', async () => {
    const folder = join(fileFolder, `zombie-${++testFolderCount}`);
    mkdirSync(folder);
    /** The file each turn's command writes its pids to, one per turn, in order. */
    const pidsFiles: string[] = [];
    /** Each turn's command, by its pid: the id of the process group it leads (CommandOptions.signal in detect.ts). */
    const commandPids: number[] = [];
    const unread: ConversationContinuation[] = [];
    const waiting: Array<(exchange: ConversationContinuation) => void> = [];
    /** The next exchange the runner reports as ended. */
    const nextEnded = () => unread.length > 0 ? Promise.resolve(unread.shift()!) : new Promise<ConversationContinuation>(resolve => waiting.push(resolve));
    let routes!: WorkViewRoutes;
    const runner = new ConversationContinuationRunner({
      recordedFolderForConversation: (platform, conversationSessionId) => store.getRecordedFolderForConversation(platform, conversationSessionId),
      detectAgent: async agentId => ({ id: agentId, path: TURN_THAT_LEAVES_ONLY_A_ZOMBIE_IN_ITS_GROUP, authenticated: true, reason: 'test login' }),
      spawnImpl: ((command: string, args: string[], options: SpawnOptions) => {
        const child = spawnRealProcess(command, args, options);
        commandPids.push(child.pid!);
        return child;
      }) as unknown as typeof spawn,
      onChange: exchange => {
        routes.publishConversationContinuation(exchange);
        const waiter = waiting.shift();
        if (waiter) waiter(exchange); else unread.push(exchange);
      },
      environment: () => {
        const pidsFile = join(folder, `turn-${pidsFiles.length + 1}.pids`);
        pidsFiles.push(pidsFile);
        return { PATH: process.env.PATH, HOME: process.env.HOME, STAND_IN_TURN_WRITES_ITS_PIDS_TO: pidsFile };
      },
    });
    routes = new WorkViewRoutes({ ...isolatedRoutesOptions(), conversationContinuationRunner: runner });
    try {
      for (const ownerMessage of ['Which word? Reply with only the word.', 'And again?']) {
        expect(await runner.start('claude', CLAUDE_SESSION, ownerMessage)).toHaveProperty('exchange');
        expect(await nextEnded()).toMatchObject({ state: 'replied', replyText: 'marmalade', ownerMessage });
        const { nonCollectingParent, zombie } = nonCollectingParentAndZombieWrittenTo(pidsFiles.at(-1)!);
        nonCollectingParents.push(nonCollectingParent);
        // The exchange ended with the zombie still in the turn's process group, which kill(2) still finds.
        const turnProcessGroup = commandPids.at(-1)!;
        expect(stateAndProcessGroupOf(zombie)).toEqual({ state: 'Z', processGroupId: turnProcessGroup });
        expect(isRunning(-turnProcessGroup)).toBe(true);
      }
      expect(runner.exchanges('claude', CLAUDE_SESSION).map(({ state, replyText }) => ({ state, replyText }))).toEqual([
        { state: 'replied', replyText: 'marmalade' },
        { state: 'replied', replyText: 'marmalade' },
      ]);
    } finally {
      routes.close();
    }
  });
});
