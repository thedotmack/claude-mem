// Continuing a conversation from My Work: the target check, the one turn a send starts, its outcome, and Stop.
// Every process here is a fake spawn, so nothing runs and nothing is spent; the folders are real ones under the
// repo's gitignored .scratch/test-runs.
import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from 'bun:test';
import { EventEmitter } from 'events';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import type { spawn, SpawnOptions } from 'child_process';
import { scratchDir } from '../../helpers/scratch-dir.js';
import { removeTempDir } from '../../helpers/temp-dir.js';
import type { UsableAgent } from '../../../src/services/agent-runner/detect.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import {
  ConversationContinuationRunner,
  readClaudeResult,
  resolveConversationContinuationTarget,
  type ConversationContinuationDependencies,
  type ConversationExchangeOrRefusal,
  type RecordedConversationFolder,
} from '../../../src/services/work-view/conversation-continuation-runner.js';
import { resumeCommandFor, type ConversationContinuation } from '../../../src/shared/conversation-continuation.js';

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'conversation-continuation');

class FakeStream extends EventEmitter {
  setEncoding(): this { return this; }
}

/**
 * Fake pids start above any real one (macOS allows at most 99,999 and Linux at most 4,194,304), so a stop sent to a
 * fake child's process group can never reach a real process, even without the process.kill stub below.
 */
let nextFakePid = 10_000_000;

/** A child process as runCommand sees one. The test decides when it exits. */
class FakeChild extends EventEmitter {
  readonly pid = nextFakePid++;
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdinText: string | null = null;
  stdin = Object.assign(new EventEmitter(), { end: (text: string) => { this.stdinText = text; } });
  /** Prints, then exits, the way a real process does. */
  exit(exitCode: number | null, output: { stdout?: string; stderr?: string } = {}): void {
    if (output.stdout) this.stdout.emit('data', output.stdout);
    if (output.stderr) this.stderr.emit('data', output.stderr);
    this.emit('close', exitCode);
  }
}

/** How a stop reached a command: runCommand's own signal to its process group, or Node's `signal` option. */
type StopDelivery = { via: 'its process group' | "Node's signal option"; signal: unknown };

interface SpawnCall { command: string; args: string[]; options: SpawnOptions; child: FakeChild; stops: StopDelivery[] }

/** Each spawn call by the process group its fake child leads, for the process.kill stub. */
const callsByProcessGroup = new Map<number, SpawnCall>();

/**
 * Keeps every call, and hears each stop the way the command would. On macOS and Linux runCommand sends it to the
 * command's process group with process.kill(-pid, signal), which the stub in beforeEach records. On Windows it comes
 * through Node's own `signal` option: Node's and Bun's spawn then send the kill signal and emit an AbortError at once,
 * while the process is still running (checked on both runtimes). Either way 'close' comes when the test calls exit().
 */
function fakeSpawn(calls: SpawnCall[]): typeof spawn {
  return ((command: string, args: string[], options: SpawnOptions) => {
    const call: SpawnCall = { command, args, options, child: new FakeChild(), stops: [] };
    calls.push(call);
    callsByProcessGroup.set(call.child.pid, call);
    options.signal?.addEventListener('abort', () => {
      call.stops.push({ via: "Node's signal option", signal: options.killSignal });
      call.child.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
    }, { once: true });
    return call.child;
  }) as unknown as typeof spawn;
}

/** What a stop sent the way this platform sends it looks like (see CommandOptions.signal). */
const stopSentToTheCommand = (signal: string): StopDelivery =>
  ({ via: process.platform === 'win32' ? "Node's signal option" : 'its process group', signal });

let restoreProcessKill = () => {};
beforeEach(() => {
  const realProcessKill = process.kill.bind(process);
  const processKill = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    const call = pid < 0 ? callsByProcessGroup.get(-pid) : undefined;
    if (!call) return realProcessKill(pid, signal);
    call.stops.push({ via: 'its process group', signal });
    return true;
  }) as typeof process.kill);
  restoreProcessKill = () => processKill.mockRestore();
});

const CLAUDE_PATH = '/usr/local/bin/claude';
const CODEX_PATH = '/usr/local/bin/codex';
const CLAUDE_SESSION = '0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const CODEX_SESSION = '019a2b3c-4d5e-7f60-8a1b-2c3d4e5f6a7b';
const WORKER_ENVIRONMENT = { PATH: '/usr/bin:/bin', HOME: '/home/tester', CLAUDE_MEM_INTERNAL: '1', CLAUDECODE: '1' };

const usableAgents = (): UsableAgent[] => [
  { id: 'claude-code', path: CLAUDE_PATH, authenticated: true, reason: 'test login' },
  { id: 'codex', path: CODEX_PATH, authenticated: true, reason: 'test login' },
  { id: 'gemini', path: null, authenticated: false, reason: 'not installed' },
];

const verboseArray = (): unknown[] => JSON.parse(readFileSync(join(FIXTURES, 'claude-result-verbose-array.json'), 'utf8'));
/** Claude Code's `--output-format json` output with `"verbose": true`, its result element changed by `result`. */
const claudeVerboseOutput = (result: Record<string, unknown>) => {
  const messages = verboseArray() as Record<string, unknown>[];
  messages[messages.length - 1] = { ...messages[messages.length - 1], ...result };
  return JSON.stringify(messages);
};

const createdFolders: string[] = [];
afterEach(async () => {
  // First, because removing a busy folder waits on real timers.
  jest.useRealTimers();
  restoreProcessKill();
  callsByProcessGroup.clear();
  for (const folder of createdFolders.splice(0)) await removeTempDir(folder);
});

/** A real folder under .scratch/test-runs, removed after the test. */
function realFolder(): string {
  const folder = scratchDir('conversation-continuation');
  createdFolders.push(folder);
  return folder;
}

function harness(overrides: Partial<ConversationContinuationDependencies> = {}, recordedFolders: Record<string, RecordedConversationFolder> = {}) {
  const calls: SpawnCall[] = [];
  const changes: ConversationContinuation[] = [];
  const unread: ConversationContinuation[] = [];
  const waiting: Array<(exchange: ConversationContinuation) => void> = [];
  let detectCalls = 0;
  const dependencies: ConversationContinuationDependencies = {
    recordedFolderForConversation: (platform, conversationSessionId) =>
      recordedFolders[`${platform}:${conversationSessionId}`] ?? { sessionIsRecorded: false, recordedFolder: null },
    detectAgents: async () => { detectCalls += 1; return usableAgents(); },
    spawnImpl: fakeSpawn(calls),
    onChange: exchange => {
      changes.push(exchange);
      const waiter = waiting.shift();
      if (waiter) waiter(exchange); else unread.push(exchange);
    },
    environment: () => ({ ...WORKER_ENVIRONMENT }),
    ...overrides,
  };
  return {
    runner: new ConversationContinuationRunner(dependencies),
    dependencies,
    calls,
    changes,
    detectCalls: () => detectCalls,
    /** The next exchange the runner reports as ended. */
    nextChange: () => unread.length > 0 ? Promise.resolve(unread.shift()!) : new Promise<ConversationContinuation>(resolve => waiting.push(resolve)),
  };
}

/** A harness whose Claude Code and Codex conversations are both recorded in `folder`. */
function harnessIn(folder: string, overrides: Partial<ConversationContinuationDependencies> = {}) {
  return harness(overrides, {
    [`claude:${CLAUDE_SESSION}`]: { sessionIsRecorded: true, recordedFolder: folder },
    [`codex:${CODEX_SESSION}`]: { sessionIsRecorded: true, recordedFolder: folder },
  });
}

function startedExchange(answer: ConversationExchangeOrRefusal): ConversationContinuation {
  if ('refusalText' in answer) throw new Error(`Expected a running exchange, got the refusal: ${answer.refusalText}`);
  return answer.exchange;
}

/**
 * Puts the test on bun's fake clock. Call it before the harness builds the runner, so that every timer the runner could
 * set is a fake one, which runEverythingThatWouldHappenLater can run. afterEach puts the real clock back.
 */
const useFakeClock = () => jest.useFakeTimers();

/**
 * Runs the work queued to happen later (promise jobs, immediates and timers), then fails if a timer is still left. In
 * order: the promise jobs and immediates already queued; every timer that is pending, however far ahead it is set
 * (jest.runOnlyPendingTimers); what those timers queued in turn; and then no timer may be pending any more, since one
 * would be work left to happen later still. The test must have been on the fake clock (useFakeClock) since before it
 * built the runner. bun's fake clock counts the timers of setTimeout and setInterval, including those of node:timers
 * and node:timers/promises (checked on bun 1.3.9). It does not fake setImmediate, and one setImmediate runs after
 * every promise job queued before it. Nothing in these tests does real I/O that could call back later.
 */
async function runEverythingThatWouldHappenLater(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  jest.runOnlyPendingTimers();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(jest.getTimerCount()).toBe(0);
}

describe('where a continued turn runs', () => {
  it('runs in the recorded folder while it exists', async () => {
    const folder = realFolder();
    const { runner, dependencies, calls } = harnessIn(folder);
    expect(resolveConversationContinuationTarget('claude', CLAUDE_SESSION, dependencies))
      .toEqual({ canContinue: true, recordedFolder: folder, runsInFolder: folder, recordedFolderIsGone: false });
    const exchange = startedExchange(await runner.start('claude', CLAUDE_SESSION, 'Which word?'));
    expect(exchange.ranInFolder).toBe(folder);
    expect(calls[0].options.cwd).toBe(folder);
  });

  it('runs in the nearest existing folder above a deleted one, and says so', async () => {
    const root = realFolder();
    const deletedWorktree = join(root, 'cleaned-up-worktree');
    const recordedFolder = join(deletedWorktree, 'packages', 'app');
    mkdirSync(recordedFolder, { recursive: true });
    rmSync(deletedWorktree, { recursive: true, force: true });
    const { runner, dependencies, calls } = harnessIn(recordedFolder);
    expect(resolveConversationContinuationTarget('codex', CODEX_SESSION, dependencies))
      .toEqual({ canContinue: true, recordedFolder, runsInFolder: root, recordedFolderIsGone: true });
    const exchange = startedExchange(await runner.start('codex', CODEX_SESSION, 'Which word?'));
    expect(exchange.ranInFolder).toBe(root);
    expect(calls[0].options.cwd).toBe(root);
  });

  it('refuses no folder recorded, a non-UUID id, another tool and an unknown session, each in its own sentence, and runs nothing', async () => {
    const folder = realFolder();
    const { runner, dependencies, calls, detectCalls } = harness({}, {
      [`claude:${CLAUDE_SESSION}`]: { sessionIsRecorded: true, recordedFolder: null },
      'claude:manual-content-project-claude': { sessionIsRecorded: true, recordedFolder: folder },
      [`gemini:${CLAUDE_SESSION}`]: { sessionIsRecorded: true, recordedFolder: folder },
    });
    const cases: Array<[string, string]> = [
      ['claude', CLAUDE_SESSION],
      ['claude', 'manual-content-project-claude'],
      ['gemini', CLAUDE_SESSION],
      ['codex', CODEX_SESSION],
    ];
    const sentences: string[] = [];
    for (const [platform, conversationSessionId] of cases) {
      const target = resolveConversationContinuationTarget(platform, conversationSessionId, dependencies);
      expect(target.canContinue).toBe(false);
      expect(target.refusalText).toMatch(/\.$/);
      sentences.push(target.refusalText!);
      expect(await runner.start(platform, conversationSessionId, 'Which word?')).toEqual({ refusalText: target.refusalText! });
    }
    expect(sentences).toEqual([
      'No folder was recorded for this Claude Code conversation, so it can’t be continued from here.',
      'This Claude Code conversation has no resumable session id, so it can’t be continued from here.',
      'Only Claude Code and Codex conversations can be continued from here.',
      'This Codex conversation is not recorded on this computer, so it can’t be continued from here.',
    ]);
    expect(calls).toHaveLength(0);
    expect(detectCalls()).toBe(0);
  });

  it('refuses a folder it cannot check, with the error, rather than taking it for a deleted one', async () => {
    const permissionDenied = Object.assign(new Error("EACCES: permission denied, stat '/work/locked/app'"), { code: 'EACCES' });
    const { runner, dependencies, calls } = harness(
      { isExistingFolder: () => { throw permissionDenied; } },
      { [`claude:${CLAUDE_SESSION}`]: { sessionIsRecorded: true, recordedFolder: '/work/locked/app' } },
    );
    const target = resolveConversationContinuationTarget('claude', CLAUDE_SESSION, dependencies);
    expect(target).toEqual({
      canContinue: false,
      recordedFolder: '/work/locked/app',
      refusalText: "The folder this Claude Code conversation ran in could not be checked (EACCES: permission denied, stat '/work/locked/app'), so it can’t be continued from here.",
    });
    expect(await runner.start('claude', CLAUDE_SESSION, 'Which word?')).toEqual({ refusalText: target.refusalText! });
    expect(calls).toHaveLength(0);
  });

  it('refuses a conversation when neither its folder nor any folder above it exists, and runs nothing', async () => {
    const { runner, dependencies, calls } = harness(
      { isExistingFolder: () => false },
      { [`codex:${CODEX_SESSION}`]: { sessionIsRecorded: true, recordedFolder: '/work/gone/app' } },
    );
    const target = resolveConversationContinuationTarget('codex', CODEX_SESSION, dependencies);
    expect(target).toEqual({
      canContinue: false,
      recordedFolder: '/work/gone/app',
      refusalText: 'Neither the folder this Codex conversation ran in nor any folder above it exists on this computer, so it can’t be continued from here.',
    });
    expect(await runner.start('codex', CODEX_SESSION, 'Which word?')).toEqual({ refusalText: target.refusalText! });
    expect(calls).toHaveLength(0);
  });
});

describe('the one turn a send starts', () => {
  it('gives Claude Code and Codex exactly their arguments; the message goes on stdin and into no argument', async () => {
    const folder = realFolder();
    const { runner, calls, nextChange } = harnessIn(folder);
    const messages = [
      'Which word? Reply with only the word.',
      '--resume 00000000-0000-4000-8000-000000000000 --print',
      'x"; rm -rf ~; echo "',
    ];
    for (const ownerMessage of messages) {
      startedExchange(await runner.start('claude', CLAUDE_SESSION, ownerMessage));
      startedExchange(await runner.start('codex', CODEX_SESSION, ownerMessage));
      const claudeCall = calls[calls.length - 2];
      const codexCall = calls[calls.length - 1];
      expect(claudeCall.command).toBe(CLAUDE_PATH);
      expect(claudeCall.args).toEqual(['--resume', CLAUDE_SESSION, '-p', '--output-format', 'json']);
      expect(codexCall.command).toBe(CODEX_PATH);
      expect(codexCall.args).toEqual(['exec', 'resume', CODEX_SESSION, '-', '--skip-git-repo-check']);
      for (const call of [claudeCall, codexCall]) {
        expect(call.child.stdinText).toBe(ownerMessage);
        expect(call.options.shell).toBeUndefined();
        expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
        // How Stop can reach the CLI (see CommandOptions.signal): a process group of its own on macOS and Linux, so
        // a stop also reaches a CLI behind a launcher script; Node's own abort on Windows.
        if (process.platform === 'win32') {
          expect(call.options.signal).toBeInstanceOf(AbortSignal);
          expect(call.options.killSignal).toBe('SIGINT');
        } else {
          expect(call.options.detached).toBe(true);
          expect(call.options.signal).toBeUndefined();
        }
      }
      claudeCall.child.exit(0, { stdout: claudeVerboseOutput({}) });
      await nextChange();
      codexCall.child.exit(0, { stdout: 'marmalade\n' });
      await nextChange();
    }
    expect(calls).toHaveLength(messages.length * 2);
  });

  it('hands the child a cleaned environment with no CLAUDE_MEM_INTERNAL, even when the worker has it', async () => {
    const { runner, calls } = harnessIn(realFolder());
    startedExchange(await runner.start('claude', CLAUDE_SESSION, 'Which word?'));
    startedExchange(await runner.start('codex', CODEX_SESSION, 'Which word?'));
    for (const call of calls) {
      const childEnvironment = call.options.env as NodeJS.ProcessEnv;
      expect('CLAUDE_MEM_INTERNAL' in childEnvironment).toBe(false);
      // sanitizeEnv also drops the worker's own Claude Code session marker.
      expect('CLAUDECODE' in childEnvironment).toBe(false);
      expect(childEnvironment.PATH).toBe(WORKER_ENVIRONMENT.PATH);
      expect(childEnvironment.HOME).toBe(WORKER_ENVIRONMENT.HOME);
    }
  });

  it('reads both shapes of Claude Code JSON output: the verbose array and the single result object', () => {
    const fixtureText = readFileSync(join(FIXTURES, 'claude-result-verbose-array.json'), 'utf8');
    const resultObject = JSON.stringify(verboseArray().at(-1));
    const marmalade = { replyText: 'marmalade', isError: false, deniedToolCallCount: 0 };
    expect(readClaudeResult(fixtureText)).toEqual(marmalade);
    expect(readClaudeResult(resultObject)).toEqual(marmalade);
    expect(readClaudeResult('marmalade')).toBeNull();
    expect(readClaudeResult(JSON.stringify([{ type: 'system', subtype: 'init' }]))).toBeNull();
    expect(readClaudeResult(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, permission_denials: [] }))).toBeNull();
  });

  it('records the reply and the denied tool calls of a finished turn', async () => {
    const { runner, calls, nextChange } = harnessIn(realFolder());
    const running = startedExchange(await runner.start('claude', CLAUDE_SESSION, 'Fix the build.'));
    expect(running.state).toBe('running');
    calls[0].child.exit(0, { stdout: claudeVerboseOutput({ result: 'I could not run the build.', permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Edit' }] }) });
    const ended = await nextChange();
    expect(ended).toMatchObject({ exchangeId: running.exchangeId, state: 'replied', replyText: 'I could not run the build.', deniedToolCallCount: 2, ownerMessage: 'Fix the build.' });
    expect(ended.endedAtEpochMs).toBeGreaterThanOrEqual(running.startedAtEpochMs);
    expect(runner.exchanges('claude', CLAUDE_SESSION)).toEqual([ended]);
  });

  it("ends failed in the tool's own words when it refuses, exits non-zero, prints unreadable output or cannot start", async () => {
    const folder = realFolder();
    const outcomes: Array<[string, (child: FakeChild) => void, string]> = [
      ['claude', child => child.exit(1, { stdout: claudeVerboseOutput({ is_error: true, result: 'Not logged in · Please run /login' }) }),
        'Claude Code exited with code 1.\n\nNot logged in · Please run /login'],
      ['claude', child => child.exit(1, { stderr: `No conversation found with session ID: ${CLAUDE_SESSION}\n` }),
        `Claude Code exited with code 1.\n\nNo conversation found with session ID: ${CLAUDE_SESSION}`],
      ['claude', child => child.exit(0, { stdout: 'marmalade\n' }),
        'Claude Code finished, but what it printed is not the JSON result this reads. All of it:\n\nmarmalade'],
      ['claude', child => child.exit(0, { stdout: claudeVerboseOutput({ is_error: true, result: 'Prompt is too long' }) }),
        'Claude Code reported an error.\n\nPrompt is too long'],
      ['claude', child => child.emit('error', Object.assign(new Error(`spawn ${CLAUDE_PATH} ENOENT`), { code: 'ENOENT' })),
        `Claude Code could not start: spawn ${CLAUDE_PATH} ENOENT`],
      ['codex', child => child.exit(1, { stderr: `Error: thread/resume: thread/resume failed: no rollout found for thread id ${CODEX_SESSION} (code -32600)\n` }),
        `Codex exited with code 1.\n\nError: thread/resume: thread/resume failed: no rollout found for thread id ${CODEX_SESSION} (code -32600)`],
      ['codex', child => child.exit(null), 'Codex was ended by a signal before it finished.'],
    ];
    for (const [platform, end, failureText] of outcomes) {
      const { runner, calls, nextChange } = harnessIn(folder);
      const conversationSessionId = platform === 'claude' ? CLAUDE_SESSION : CODEX_SESSION;
      startedExchange(await runner.start(platform, conversationSessionId, 'Which word?'));
      end(calls[0].child);
      const ended = await nextChange();
      expect(ended.state).toBe('failed');
      expect(ended.failureText).toBe(failureText);
      expect(ended.replyText).toBeUndefined();
    }
  });

  it('brings a long reply and a long error back whole', async () => {
    const longReply = 'marmalade '.repeat(20_000);
    const longError = 'e'.repeat(200_000);
    expect(longReply).toHaveLength(200_000);
    const folder = realFolder();

    const claude = harnessIn(folder);
    startedExchange(await claude.runner.start('claude', CLAUDE_SESSION, 'Repeat it.'));
    claude.calls[0].child.exit(0, { stdout: claudeVerboseOutput({ result: longReply }) });
    const claudeReply = await claude.nextChange();
    expect(claudeReply.replyText).toHaveLength(longReply.length);
    expect(claudeReply.replyText).toBe(longReply);

    const codex = harnessIn(folder);
    startedExchange(await codex.runner.start('codex', CODEX_SESSION, 'Repeat it.'));
    codex.calls[0].child.exit(0, { stdout: `${longReply.trimEnd()}\n` });
    expect((await codex.nextChange()).replyText).toBe(longReply.trimEnd());

    const failingClaude = harnessIn(folder);
    startedExchange(await failingClaude.runner.start('claude', CLAUDE_SESSION, 'Repeat it.'));
    failingClaude.calls[0].child.exit(1, { stderr: longError });
    const claudeFailure = 'Claude Code exited with code 1.\n\n' + longError;
    const claudeFailed = await failingClaude.nextChange();
    expect(claudeFailed.failureText).toHaveLength(claudeFailure.length);
    expect(claudeFailed.failureText).toBe(claudeFailure);

    const failingCodex = harnessIn(folder);
    startedExchange(await failingCodex.runner.start('codex', CODEX_SESSION, 'Repeat it.'));
    failingCodex.calls[0].child.exit(1, { stderr: longError });
    const codexFailure = 'Codex exited with code 1.\n\n' + longError;
    const codexFailed = await failingCodex.nextChange();
    expect(codexFailed.failureText).toHaveLength(codexFailure.length);
    expect(codexFailed.failureText).toBe(codexFailure);
  });
});

describe('one turn per conversation, Stop, and nothing later', () => {
  it('refuses a second send while the first is running, and starts nothing for it', async () => {
    const { runner, calls, detectCalls } = harnessIn(realFolder());
    startedExchange(await runner.start('claude', CLAUDE_SESSION, 'first'));
    expect(await runner.start('claude', CLAUDE_SESSION, 'second')).toEqual({
      refusalText: 'This conversation is still answering your last message from here. Wait for its reply, or stop it, before you send another.',
    });
    expect(calls).toHaveLength(1);
    expect(detectCalls()).toBe(1);
    expect(runner.exchanges('claude', CLAUDE_SESSION).map(exchange => exchange.ownerMessage)).toEqual(['first']);
  });

  it('refuses a second send while the first is still checking the CLI login', async () => {
    let finishDetection!: (agents: UsableAgent[]) => void;
    const detection = new Promise<UsableAgent[]>(resolve => { finishDetection = resolve; });
    const { runner, calls } = harnessIn(realFolder(), { detectAgents: () => detection });
    const firstStart = runner.start('claude', CLAUDE_SESSION, 'first');
    expect(await runner.start('claude', CLAUDE_SESSION, 'second')).toHaveProperty('refusalText');
    finishDetection(usableAgents());
    startedExchange(await firstStart);
    expect(calls).toHaveLength(1);
    expect(calls[0].child.stdinText).toBe('first');
  });

  it('keeps two sends in order, and the first keeps its message and reply', async () => {
    const { runner, calls, changes, nextChange } = harnessIn(realFolder());
    const first = startedExchange(await runner.start('codex', CODEX_SESSION, 'Remember the word marmalade. Reply only: ok'));
    expect(changes).toHaveLength(0);
    calls[0].child.exit(0, { stdout: 'ok\n' });
    await nextChange();
    const second = startedExchange(await runner.start('codex', CODEX_SESSION, 'Which word? Reply with only the word.'));
    calls[1].child.exit(0, { stdout: 'marmalade\n' });
    await nextChange();
    expect(second.exchangeId).toBeGreaterThan(first.exchangeId);
    expect(runner.exchanges('codex', CODEX_SESSION).map(({ exchangeId, state, ownerMessage, replyText }) => ({ exchangeId, state, ownerMessage, replyText }))).toEqual([
      { exchangeId: first.exchangeId, state: 'replied', ownerMessage: 'Remember the word marmalade. Reply only: ok', replyText: 'ok' },
      { exchangeId: second.exchangeId, state: 'replied', ownerMessage: 'Which word? Reply with only the word.', replyText: 'marmalade' },
    ]);
    expect(changes.map(exchange => exchange.exchangeId)).toEqual([first.exchangeId, second.exchangeId]);
  });

  it('never runs a failed turn again, even on a timer, and a new runner (a worker restart) starts nothing', async () => {
    useFakeClock();
    const { runner, dependencies, calls, detectCalls, nextChange } = harnessIn(realFolder());
    startedExchange(await runner.start('claude', CLAUDE_SESSION, 'Which word?'));
    calls[0].child.exit(1, { stdout: claudeVerboseOutput({ is_error: true, result: "You've hit your usage limit. It resets at 4pm." }) });
    const failed = await nextChange();
    expect(failed.state).toBe('failed');
    await runEverythingThatWouldHappenLater();
    expect(calls).toHaveLength(1);

    const restarted = new ConversationContinuationRunner(dependencies);
    await runEverythingThatWouldHappenLater();
    expect(calls).toHaveLength(1);
    expect(detectCalls()).toBe(1);
    expect(restarted.exchanges('claude', CLAUDE_SESSION)).toEqual([]);
    expect(runner.exchanges('claude', CLAUDE_SESSION)).toEqual([failed]);
  });

  it("stops with one SIGINT to the CLI's process group, stays running until the CLI has exited, then says it was stopped", async () => {
    useFakeClock();
    const { runner, calls, changes, nextChange } = harnessIn(realFolder());
    const running = startedExchange(await runner.start('claude', CLAUDE_SESSION, 'Count slowly to 200, one number per line.'));
    expect(runner.stop('claude', CLAUDE_SESSION)).toEqual({ exchange: running });
    expect(calls[0].stops).toEqual([stopSentToTheCommand('SIGINT')]);
    // The CLI is still ending its turn: a send now would be a second writer on the same transcript.
    await runEverythingThatWouldHappenLater();
    expect(changes).toHaveLength(0);
    expect(runner.exchanges('claude', CLAUDE_SESSION)[0].state).toBe('running');
    expect(await runner.start('claude', CLAUDE_SESSION, 'next')).toHaveProperty('refusalText');
    expect(calls).toHaveLength(1);

    // As Claude Code did when stopped while one of its tools ran (real run): it printed nothing and exited 0.
    calls[0].child.exit(0);
    const stopped = await nextChange();
    expect(stopped).toMatchObject({ exchangeId: running.exchangeId, state: 'failed', failureText: 'You stopped this turn.' });
    startedExchange(await runner.start('claude', CLAUDE_SESSION, 'next'));
    expect(calls).toHaveLength(2);
  });

  it('refuses Stop when nothing is running', async () => {
    const { runner, calls, nextChange } = harnessIn(realFolder());
    expect(runner.stop('claude', CLAUDE_SESSION)).toEqual({ refusalText: 'Nothing sent from here is running in this conversation.' });
    startedExchange(await runner.start('claude', CLAUDE_SESSION, 'Which word?'));
    calls[0].child.exit(0, { stdout: claudeVerboseOutput({}) });
    await nextChange();
    expect(runner.stop('claude', CLAUDE_SESSION)).toHaveProperty('refusalText');
  });

  it('refuses a CLI that is not installed or not logged in before anything runs', async () => {
    let detection = 0;
    const { runner, calls } = harnessIn(realFolder(), {
      detectAgents: async () => {
        detection += 1;
        if (detection > 2) return usableAgents();
        return [
          { id: 'claude-code', path: null, authenticated: false, reason: 'not installed: Claude executable not found.' },
          { id: 'codex', path: CODEX_PATH, authenticated: false, reason: '`codex login status` exited 1: Not logged in' },
          { id: 'gemini', path: null, authenticated: false, reason: 'not installed' },
        ];
      },
    });
    expect(await runner.start('claude', CLAUDE_SESSION, 'Which word?')).toEqual({ refusalText: 'Claude Code is not installed on this computer.' });
    expect(await runner.start('codex', CODEX_SESSION, 'Which word?'))
      .toEqual({ refusalText: 'Codex is not logged in on this computer (`codex login status` exited 1: Not logged in).' });
    expect(calls).toHaveLength(0);
    // A refusal leaves the conversation free: the next send runs once the CLI is there.
    startedExchange(await runner.start('claude', CLAUDE_SESSION, 'Which word?'));
    expect(calls).toHaveLength(1);
  });

  it('refuses an empty message', async () => {
    const { runner, calls, detectCalls } = harnessIn(realFolder());
    expect(await runner.start('claude', CLAUDE_SESSION, ' \n ')).toEqual({ refusalText: 'There is no message to send.' });
    expect(calls).toHaveLength(0);
    expect(detectCalls()).toBe(0);
  });
});

describe('after Stop, the outcome follows how the CLI ended and what it printed', () => {
  const countToTwoHundred = Array.from({ length: 200 }, (_, index) => String(index + 1)).join('\n');

  /** Starts a turn, presses Stop, then ends the CLI the way `end` says, and answers with the ended exchange. */
  async function stopThenEnd(platform: 'claude' | 'codex', end: (child: FakeChild) => void): Promise<ConversationContinuation> {
    const { runner, calls, nextChange } = harnessIn(realFolder());
    const conversationSessionId = platform === 'claude' ? CLAUDE_SESSION : CODEX_SESSION;
    startedExchange(await runner.start(platform, conversationSessionId, 'Count slowly to 200, one number per line.'));
    expect(runner.stop(platform, conversationSessionId)).toHaveProperty('exchange');
    end(calls[0].child);
    return nextChange();
  }

  it('keeps the reply of a Claude Code turn that finished before the stop reached it, however the CLI then exited', async () => {
    // Real runs: Stop pressed while claude-mem's hook ran after the turn, and Stop pressed once the result was on
    // stdout. Each time Claude Code printed its whole reply and exited 0. A stop that lands while it shuts down after
    // printing could also end it with a code, or by the signal.
    for (const exitCode of [0, 130, null]) {
      const ended = await stopThenEnd('claude', child => child.exit(exitCode, { stdout: claudeVerboseOutput({ result: countToTwoHundred }) }));
      expect(ended).toMatchObject({ state: 'replied', replyText: countToTwoHundred, deniedToolCallCount: 0 });
      expect(ended.failureText).toBeUndefined();
    }
  });

  it('says a Claude Code turn stopped while writing its reply was stopped, and keeps what it had written and its words', async () => {
    // The shape of a real run stopped mid-reply with "verbose": true: an assistant message holding what it had written,
    // then a result with is_error, subtype error_during_execution, no `result`, and an `errors` list. It exited 0.
    const stoppedMidReply = readFileSync(join(FIXTURES, 'claude-result-stopped-mid-reply.json'), 'utf8');
    const ended = await stopThenEnd('claude', child => child.exit(0, { stdout: stoppedMidReply, stderr: 'a line on stderr\n' }));
    expect(ended.state).toBe('failed');
    expect(ended.failureText).toBe(
      'You stopped this turn.\n\n1\n2\n3\n4\n5\n\n[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null\n\na line on stderr',
    );
    expect(ended.replyText).toBeUndefined();
  });

  it('shows everything a stopped Claude Code turn printed, as it is, when it is not the JSON result', async () => {
    const ended = await stopThenEnd('claude', child => child.exit(130, { stdout: 'partial output\n', stderr: 'Interrupted\n' }));
    expect(ended).toMatchObject({ state: 'failed', failureText: 'You stopped this turn.\n\npartial output\n\nInterrupted' });
  });

  it('keeps the reply of a Codex turn that finished before the stop reached it', async () => {
    const ended = await stopThenEnd('codex', child => child.exit(0, { stdout: `${countToTwoHundred}\n`, stderr: 'progress\n' }));
    expect(ended).toMatchObject({ state: 'replied', replyText: countToTwoHundred });
    expect(ended.failureText).toBeUndefined();
  });

  it('says a Codex turn the stop interrupted was stopped, and keeps everything it printed', async () => {
    // The shape of a real run: Codex's progress on stderr ends with "turn interrupted", and it exited 1.
    const progress = 'user\nCount slowly to 200, one number per line.\ncodex\n1\n2\n3\nturn interrupted\ntokens used\n12,345\n';
    const ended = await stopThenEnd('codex', child => child.exit(1, { stderr: progress }));
    expect(ended).toMatchObject({ state: 'failed', failureText: `You stopped this turn.\n\n${progress.trimEnd()}` });
    expect(ended.replyText).toBeUndefined();
  });
});

describe('SessionStore.getRecordedFolderForConversation', () => {
  it('tells an unknown conversation from one with no folder and one with a folder', async () => {
    const databaseFolder = realFolder();
    const store = new SessionStore(join(databaseFolder, 'claude-mem.db'));
    try {
      const withFolder = store.createSDKSession(CLAUDE_SESSION, 'example', 'Remember the word marmalade.', undefined, 'claude');
      store.setSessionCwd(withFolder, '/work/example');
      store.createSDKSession(CODEX_SESSION, 'example', 'Remember the word marmalade.', undefined, 'codex');
      expect(store.getRecordedFolderForConversation('claude', CLAUDE_SESSION)).toEqual({ sessionIsRecorded: true, recordedFolder: '/work/example' });
      expect(store.getRecordedFolderForConversation('codex', CODEX_SESSION)).toEqual({ sessionIsRecorded: true, recordedFolder: null });
      expect(store.getRecordedFolderForConversation('codex', CLAUDE_SESSION)).toEqual({ sessionIsRecorded: false, recordedFolder: null });
    } finally {
      store.close();
    }
  });
});

describe('resumeCommandFor', () => {
  it('builds the resume command from fixed words and the UUID, and nothing for anything else', () => {
    expect(resumeCommandFor('claude', CLAUDE_SESSION)).toBe(`claude --resume ${CLAUDE_SESSION}`);
    expect(resumeCommandFor('codex', CODEX_SESSION)).toBe(`codex resume ${CODEX_SESSION}`);
    expect(resumeCommandFor('claude', 'manual-content-project-claude')).toBeNull();
    expect(resumeCommandFor('claude', `${CLAUDE_SESSION}; rm -rf ~`)).toBeNull();
    expect(resumeCommandFor('gemini', CLAUDE_SESSION)).toBeNull();
  });
});
