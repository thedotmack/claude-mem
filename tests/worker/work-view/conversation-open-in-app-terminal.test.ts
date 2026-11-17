// Opening a conversation in its app through the pseudo-terminal the runner gives Claude Code on macOS
// (PSEUDO_TERMINAL_COMMAND in conversation-continuation-runner.ts), with real processes: the real /usr/bin/script, and a
// stand-in for `claude --desktop --resume <session uuid>` that, like Claude Code 2.1.325, refuses unless its stdout and
// stdin are a terminal, and prints its refusal with the same color and cursor codes. The stand-in opens nothing, and no
// Claude Code runs. macOS only: elsewhere the worker opens no conversation in an app, which the runner's own tests cover.
import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { scratchDir } from '../../helpers/scratch-dir.js';
import { removeTempDir } from '../../helpers/temp-dir.js';
import { runCommand } from '../../../src/services/agent-runner/detect.js';
import {
  ConversationContinuationRunner,
  type ConversationContinuationDependencies,
} from '../../../src/services/work-view/conversation-continuation-runner.js';
import type { ConversationContinuation } from '../../../src/shared/conversation-continuation.js';

const STAND_IN = join(import.meta.dir, '..', '..', 'fixtures', 'conversation-continuation', 'desktop-cli-that-needs-a-terminal.sh');
const CLAUDE_SESSION = '0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
/** Ids the page makes for clicks on "Open in Claude" (crypto.randomUUID): one per click. */
const FIRST_CLICK = '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
const SECOND_CLICK = '2c3d4e5f-6071-4b8c-9dae-1f2a3b4c5d6e';
const DID_NOT_OPEN = 'Claude Code could not open this conversation in the Claude app.';
const STILL_OPENING = 'Claude Code is still opening this conversation in the Claude app from an earlier click. Wait for it to finish, or reload the page you clicked it in to stop it.';
/** The worker's own terminal settings on the owner's computer, which the runner replaces with TERM=dumb. */
const WORKER_ENVIRONMENT = { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm-256color', COLORTERM: 'truecolor' };

/** Whether a process is still running. EPERM would mean it runs as someone else, so it runs. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const createdFolders: string[] = [];
/** Stand-ins started to hang. Ended after each test in case a test failed before its stop reached one. */
const hangingStandInPids: number[] = [];
afterEach(async () => {
  for (const pid of hangingStandInPids.splice(0)) if (isRunning(pid)) process.kill(pid, 'SIGKILL');
  for (const folder of createdFolders.splice(0)) await removeTempDir(folder);
});

/** A runner whose Claude Code is the stand-in, over a real recorded folder under .scratch/test-runs. */
function runnerWithStandIn(overrides: Partial<ConversationContinuationDependencies> = {}) {
  const folder = scratchDir('conversation-open-in-app');
  createdFolders.push(folder);
  const changes: ConversationContinuation[] = [];
  const runner = new ConversationContinuationRunner({
    recordedFolderForConversation: () => ({ sessionIsRecorded: true, recordedFolder: folder }),
    // Only Claude Code is found, and it is the stand-in.
    detectAgent: async agentId => agentId === 'claude-code'
      ? { id: agentId, path: STAND_IN, authenticated: true, reason: 'test login' }
      : { id: agentId, path: null, authenticated: false, reason: 'not installed: only Claude Code is in this test' },
    spawnImpl: spawn,
    onChange: exchange => { changes.push(exchange); },
    environment: () => ({ ...WORKER_ENVIRONMENT }),
    ...overrides,
  });
  return { runner, changes, folder };
}

/** The pid the hanging stand-in wrote to `pidFile`, once it has. Bun's per-test timeout ends the wait if it never does. */
async function pidWrittenTo(pidFile: string): Promise<number> {
  for (;;) {
    const written = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : '';
    if (written !== '') return Number(written);
    await Bun.sleep(10);
  }
}

const describeOnMacOs = process.platform === 'darwin' ? describe : describe.skip;

describeOnMacOs('opening a conversation in its app through a pseudo-terminal, with real processes', () => {
  it('gives the CLI a terminal on stdout and stdin, and answers that the app opened the conversation, with what it printed', async () => {
    const { runner, changes } = runnerWithStandIn();
    expect(await runner.openInApp('claude', CLAUDE_SESSION)).toEqual({
      opened: true, printedText: `Opening session ${CLAUDE_SESSION} in Claude Desktop`,
    });
    expect(changes).toHaveLength(0);
    expect(runner.exchanges('claude', CLAUDE_SESSION)).toEqual([]);
  });

  it("answers a refusal in the CLI's own words, without the terminal's echo, its \\r\\n line ends or the color and cursor codes", async () => {
    const { runner } = runnerWithStandIn({ environment: () => ({ ...WORKER_ENVIRONMENT, STAND_IN_DESKTOP_HAS_NO_SESSION: '1' }) });
    expect(await runner.openInApp('claude', CLAUDE_SESSION)).toEqual({
      refusalText: `${DID_NOT_OPEN} Claude Code exited with code 1.\n\nNo session found with ID ${CLAUDE_SESSION}. Run \`claude --resume\` to pick a session, then /desktop inside it.`,
    });
  });

  it('ends the CLI behind the pseudo-terminal when the page that asked goes away, refuses a second open meanwhile, and opens again after', async () => {
    const pidFolder = scratchDir('conversation-open-in-app-pid');
    createdFolders.push(pidFolder);
    const pidFile = join(pidFolder, 'stand-in.pid');
    let hangs = true;
    const { runner } = runnerWithStandIn({
      environment: () => ({ ...WORKER_ENVIRONMENT, ...(hangs ? { STAND_IN_DESKTOP_HANGS_WRITING_ITS_PID_TO: pidFile } : {}) }),
    });
    const opening = runner.openInApp('claude', CLAUDE_SESSION, FIRST_CLICK);
    const standInPid = await pidWrittenTo(pidFile);
    hangingStandInPids.push(standInPid);
    expect(isRunning(standInPid)).toBe(true);
    // A click from another tab while it hangs starts no second script and CLI, and its stop leaves this open running.
    expect(await runner.openInApp('claude', CLAUDE_SESSION, SECOND_CLICK)).toEqual({ refusalText: STILL_OPENING });
    expect(runner.stopOpeningInApp('claude', CLAUDE_SESSION, SECOND_CLICK)).toHaveProperty('refusalText');
    expect(isRunning(standInPid)).toBe(true);

    expect(runner.stopOpeningInApp('claude', CLAUDE_SESSION, FIRST_CLICK)).toEqual({ stopping: true });
    expect(await opening).toEqual({
      refusalText: 'Claude Code could not open this conversation in the Claude app: the page that asked went away, so it was stopped.',
    });
    // script ended by the stop, and the CLI, which runs in a session of its own behind script's pseudo-terminal, ended with
    // it. Bun's per-test timeout fails the test if it never does.
    while (isRunning(standInPid)) await Bun.sleep(10);

    hangs = false;
    expect(await runner.openInApp('claude', CLAUDE_SESSION)).toEqual({
      opened: true, printedText: `Opening session ${CLAUDE_SESSION} in Claude Desktop`,
    });
  });

  it('needs the terminal script gives it: run without one, as the worker would, the stand-in refuses because its output is redirected', async () => {
    const result = await runCommand(STAND_IN, ['--desktop', '--resume', CLAUDE_SESSION], { env: { ...WORKER_ENVIRONMENT } });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe("--desktop opens the Claude Desktop app and can't run non-interactively (`--print`, `--sdk-url`, `--init-only`, or redirected output).\n");
  });
});
