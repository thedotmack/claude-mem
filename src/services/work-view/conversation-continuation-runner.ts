/**
 * Continues a Claude Code or Codex conversation from My Work. The owner's message becomes one headless turn in that
 * same conversation, run by the owner's own CLI with the owner's own login, settings, hooks and plugins, so claude-mem
 * captures the turn like any other. The exchange (the message and what came back) is kept in this worker's memory for
 * the page to show.
 *
 * The owner clicked, so a start is the one run that click starts. Nothing queues, nothing is sent a second time and
 * nothing is written to disk. A failed run is recorded as failed and stops. Nothing here runs at construction, on a
 * timer, at worker start or on reconnect.
 *
 * The two commands, as the CLIs document them:
 *   - Claude Code 2.1.325: `claude --resume <session uuid> -p --output-format json`, the message on stdin.
 *     `-r, --resume [value]  Resume a conversation by session ID` and `-p, --print` (`claude --help`). It finds the
 *     session by its ID in any project on this machine (headless docs, "Continue conversations").
 *   - codex-cli 0.167.0: `codex exec resume <session uuid> - --skip-git-repo-check`, the message on stdin.
 *     `[PROMPT] ... If - is used, read from stdin` and `--skip-git-repo-check  Allow running Codex outside a Git
 *     repository` (`codex exec resume --help`). The final message is printed on stdout; progress goes to stderr.
 *
 * The message is never an argument, so text that starts with a dash is never read as a flag, and no shell is involved.
 * No permission, model or sandbox option is passed: the turn runs in the mode the owner's own `claude -p --resume`
 * would start in, and no option that skips hooks or plugins is passed either.
 *
 * On macOS it also opens a Claude Code conversation in the Claude desktop app, by the command Claude Code documents for
 * it, which starts no turn: `claude --desktop --resume <session uuid>` (see OPEN_IN_APP_ARGUMENTS and
 * PSEUDO_TERMINAL_COMMAND).
 *
 * The argv shapes, the UUID guard, the stdin delivery and dropping CLAUDE_MEM_INTERNAL follow Miles Wiesenthal's
 * answer-delivery.ts in PR #6054.
 */
import type { spawn } from 'child_process';
import { statSync } from 'fs';
import { dirname } from 'path';
import { stripVTControlCharacters } from 'util';
import { runCommand, type CommandResult, type UsableAgent, type UsableAgentId } from '../agent-runner/detect.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { logger } from '../../utils/logger.js';
import {
  CONVERSATION_APP_NAMES,
  CONVERSATION_SESSION_UUID_PATTERN,
  isContinuablePlatform,
  opensInItsOwnApp,
  type ContinuablePlatform,
  type ConversationContinuation,
  type ConversationContinuationTarget,
  type ConversationOpenedInApp,
  type PlatformWithItsOwnApp,
} from '../../shared/conversation-continuation.js';

/** How a turn ended, as the exchange records it. */
type TurnOutcome = Pick<ConversationContinuation, 'state' | 'replyText' | 'failureText' | 'deniedToolCallCount'>;

interface ContinuationTool {
  agentId: UsableAgentId;
  toolName: string;
  /** The command's arguments. The owner's message is never one of them: it goes on stdin. */
  argumentsFor: (conversationSessionId: string) => string[];
  /** Reads a command that started and exited with no Stop pressed. */
  readOutcome: (result: CommandResult, toolName: string) => TurnOutcome;
  /**
   * Reads a command the owner pressed Stop on, once it has exited. The turn may have finished before the stop reached
   * it, and then its reply stands. Otherwise the exchange says it was stopped and shows what the turn printed.
   */
  readStoppedOutcome: (result: CommandResult, toolName: string) => TurnOutcome;
}

const CONTINUATION_TOOLS: Record<ContinuablePlatform, ContinuationTool> = {
  claude: {
    agentId: 'claude-code',
    toolName: 'Claude Code',
    argumentsFor: conversationSessionId => ['--resume', conversationSessionId, '-p', '--output-format', 'json'],
    readOutcome: readClaudeOutcome,
    readStoppedOutcome: readStoppedClaudeOutcome,
  },
  codex: {
    agentId: 'codex',
    toolName: 'Codex',
    argumentsFor: conversationSessionId => ['exec', 'resume', conversationSessionId, '-', '--skip-git-repo-check'],
    readOutcome: readCodexOutcome,
    readStoppedOutcome: readStoppedCodexOutcome,
  },
};

/**
 * The command that opens a conversation in its tool's own app (CONVERSATION_APP_NAMES), as the CLI documents it. Claude
 * Code 2.1.325: `claude --desktop --resume <session uuid>`. `--desktop  Open in the Claude Desktop app instead of the
 * terminal`, and `--resume <id>` picks the session (`claude --help`). "Claude Code prints `Opening session <session-id>
 * in Claude Desktop`, the session opens in the app, and the command exits." It "doesn't move a session that is open in
 * another terminal or still running in the background" (desktop docs, "Coming from the CLI?"). It starts no turn.
 */
const OPEN_IN_APP_ARGUMENTS: Record<PlatformWithItsOwnApp, (conversationSessionId: string) => string[]> = {
  claude: conversationSessionId => ['--desktop', '--resume', conversationSessionId],
};

/**
 * What the app is opened through: a pseudo-terminal. Claude Code 2.1.325 opens the desktop app only when its stdin and
 * stdout are a terminal, which its docs do not say. Its --desktop handler (launchDesktopFromCli, read in the 2.1.325
 * binary) refuses when stdout is not one ("--desktop opens the Claude Desktop app and can't run non-interactively
 * (`--print`, `--sdk-url`, `--init-only`, or redirected output).") and then when stdin is not one ("--desktop doesn't take
 * piped or redirected input yet. Run `claude --desktop` on its own, then type in the app."). The worker has no terminal,
 * and runCommand reads what a command prints through pipes.
 *
 * So the command runs under macOS's /usr/bin/script: `script -q /dev/null <claude> --desktop --resume <session uuid>`.
 * script gives the command a pseudo-terminal of its own, starts it with execvp (no shell), copies what it prints to
 * script's stdout, and exits with its exit code. `-q` adds none of script's own lines, and /dev/null keeps no copy. The
 * command gets TERM=dumb, the setting the real open was checked with on 15 Nov 2026. Claude Code still writes color and
 * cursor codes to the terminal under it (printedThroughPseudoTerminal takes them out).
 *
 * Only macOS has this here, so only there does the worker open a conversation in its app (appThatOpensConversationsHere).
 * Claude Desktop also runs on x64 Windows, which has no such program: run from the worker, Claude Code refuses every
 * open there as non-interactive. Linux has no Claude Desktop.
 */
const PSEUDO_TERMINAL_COMMAND = '/usr/bin/script';

/**
 * The app the worker can open a conversation of this tool in on a computer running `operatingSystem`, or null: the
 * tool's app (CONVERSATION_APP_NAMES) on macOS, which has the pseudo-terminal its CLI needs (PSEUDO_TERMINAL_COMMAND),
 * and none anywhere else.
 */
function appThatOpensConversationsHere(platform: ContinuablePlatform, operatingSystem: NodeJS.Platform): string | null {
  return operatingSystem === 'darwin' ? CONVERSATION_APP_NAMES[platform] : null;
}

/**
 * What the command printed, from what script copied out of the pseudo-terminal. Three kinds of things in it are the
 * terminal's, not the command's words, and are taken out: the echo of the end of input that script sends it when
 * script's own stdin is empty ("^D" and two backspaces), "\r\n" for each line end, and terminal control sequences. Claude
 * Code 2.1.325 writes those even under TERM=dumb: ESC[0m ESC[31m before a refusal, ESC[0m after it and ESC[?25h as it
 * exits (real output in tests/fixtures/conversation-continuation/claude-desktop-refusal-through-script.json).
 * stripVTControlCharacters (node:util) takes out every such sequence. Every character the command printed is kept.
 */
function printedThroughPseudoTerminal(terminalOutput: string): string {
  return stripVTControlCharacters(terminalOutput.replace('^D\b\b', '').replaceAll('\r\n', '\n'));
}

const CONTINUABLE_TOOL_NAMES = Object.values(CONTINUATION_TOOLS).map(tool => tool.toolName).join(' and ');
const STILL_RUNNING_REFUSAL = 'This conversation is still answering your last message from here. Wait for its reply, or stop it, before you send another.';
const NOTHING_RUNNING_REFUSAL = 'Nothing sent from here is running in this conversation.';
const EMPTY_MESSAGE_REFUSAL = 'There is no message to send.';
const STOPPED_BY_OWNER_TEXT = 'You stopped this turn.';

/** What SessionStore.getRecordedFolderForConversation answers. */
export interface RecordedConversationFolder {
  sessionIsRecorded: boolean;
  recordedFolder: string | null;
}

export interface ConversationContinuationDependencies {
  /** The conversation's session row on this computer: SessionStore.getRecordedFolderForConversation. */
  recordedFolderForConversation: (platform: string, conversationSessionId: string) => RecordedConversationFolder;
  /** Is the CLI installed and logged in? Asked only when a turn starts, because it runs the CLIs' own status commands. */
  detectAgents: () => Promise<UsableAgent[]>;
  spawnImpl: typeof spawn;
  /** Told about each exchange once, when it ends. The running exchange is the one `start` answers with. */
  onChange: (exchange: ConversationContinuation) => void;
  /** The worker's environment, before it is cleaned for the child. Defaults to process.env. */
  environment?: () => NodeJS.ProcessEnv;
  /** Whether a path is an existing folder. Defaults to isExistingFolder below. */
  isExistingFolder?: (path: string) => boolean;
  /**
   * This computer's operating system, which decides whether the worker can open a conversation in its app
   * (appThatOpensConversationsHere). Defaults to process.platform.
   */
  operatingSystem?: () => NodeJS.Platform;
}

/** A start or a stop: the exchange it concerns, or one sentence saying why it did not happen. */
export type ConversationExchangeOrRefusal = { exchange: ConversationContinuation } | { refusalText: string };

/**
 * Opening a conversation in its app: it opened, with what the command printed as it did, or why it did not, followed by
 * what the command printed when it ran.
 */
export type OpenedInAppOrRefusal = ({ opened: true } & ConversationOpenedInApp) | { refusalText: string };

/**
 * Whether `path` is a folder that exists. "No such entry" and "a parent is not a folder" mean it is gone, and so does a
 * file in its place. Any other error, such as a folder this worker may not look at, is thrown, so a folder that is still
 * there is never taken for a deleted one.
 */
function isExistingFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * Can this conversation be continued from here, and in which folder would its turn run? Checks, in order: a tool this
 * can continue, a session id that tool resumes, a session recorded on this computer, a recorded folder. A recorded
 * folder that is gone is the usual case once a worktree is cleaned up, and both CLIs find a conversation by its id from
 * any folder, so the turn then runs in the nearest folder above it that still exists, and the target says so before
 * anything is sent.
 *
 * It runs no agent detection: the page asks this for every conversation row the owner opens. It also says which app, if
 * any, the worker can open the conversation in on this computer (opensInAppNamed).
 */
export function resolveConversationContinuationTarget(
  platform: string,
  conversationSessionId: string,
  dependencies: Pick<ConversationContinuationDependencies, 'recordedFolderForConversation' | 'isExistingFolder' | 'operatingSystem'>,
): ConversationContinuationTarget {
  if (!isContinuablePlatform(platform)) {
    return { canContinue: false, refusalText: `Only ${CONTINUABLE_TOOL_NAMES} conversations can be continued from here.`, recordedFolder: null };
  }
  const { toolName } = CONTINUATION_TOOLS[platform];
  if (!CONVERSATION_SESSION_UUID_PATTERN.test(conversationSessionId)) {
    return { canContinue: false, refusalText: `This ${toolName} conversation has no resumable session id, so it can’t be continued from here.`, recordedFolder: null };
  }
  const recorded = dependencies.recordedFolderForConversation(platform, conversationSessionId);
  if (!recorded.sessionIsRecorded) {
    return { canContinue: false, refusalText: `This ${toolName} conversation is not recorded on this computer, so it can’t be continued from here.`, recordedFolder: null };
  }
  const recordedFolder = recorded.recordedFolder;
  if (!recordedFolder) {
    return { canContinue: false, refusalText: `No folder was recorded for this ${toolName} conversation, so it can’t be continued from here.`, recordedFolder: null };
  }
  const folderExists = dependencies.isExistingFolder ?? isExistingFolder;
  const opensInAppNamed = appThatOpensConversationsHere(platform, dependencies.operatingSystem?.() ?? process.platform);
  try {
    if (folderExists(recordedFolder)) return { canContinue: true, recordedFolder, runsInFolder: recordedFolder, recordedFolderIsGone: false, opensInAppNamed };
    for (let candidate = dirname(recordedFolder); ; candidate = dirname(candidate)) {
      if (folderExists(candidate)) return { canContinue: true, recordedFolder, runsInFolder: candidate, recordedFolderIsGone: true, opensInAppNamed };
      if (dirname(candidate) === candidate) break;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { canContinue: false, refusalText: `The folder this ${toolName} conversation ran in could not be checked (${reason}), so it can’t be continued from here.`, recordedFolder };
  }
  return { canContinue: false, refusalText: `Neither the folder this ${toolName} conversation ran in nor any folder above it exists on this computer, so it can’t be continued from here.`, recordedFolder };
}

export interface ClaudeTurnResult {
  /** The result message's `result`: the reply, or the failure when `isError`. */
  replyText: string;
  isError: boolean;
  deniedToolCallCount: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Claude Code's `--output-format json` output as its messages: one object, or, when the owner's settings have
 * `"verbose": true`, an array of them (system/init, assistant, rate_limit_event, result). Null when it is not JSON.
 */
function readClaudeMessages(stdout: string): Record<string, unknown>[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not JSON at all: the caller reports it as unreadable, with the whole output.
    return null;
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(isRecord);
}

/**
 * Reads the turn's result from Claude Code's `--output-format json` output: its last message whose `type` is
 * `result`. Anything else is null, and the caller then shows everything the tool printed.
 */
export function readClaudeResult(stdout: string): ClaudeTurnResult | null {
  const result = readClaudeMessages(stdout)?.filter(message => message.type === 'result').at(-1);
  if (!isRecord(result) || typeof result.result !== 'string' || typeof result.is_error !== 'boolean' || !Array.isArray(result.permission_denials)) return null;
  return { replyText: result.result, isError: result.is_error, deniedToolCallCount: result.permission_denials.length };
}

/**
 * The words a Claude Code turn that did not finish printed, in order: what it had written of its reply (the text of its
 * assistant messages, which Claude Code prints only with `"verbose": true`), then its result message's `result` and
 * `errors`. The rest of that output is the session's start-up listing (system/init), thinking, tool calls and their
 * results, and counters. Null when the output is not Claude Code's JSON with a result message: the caller then shows
 * the output as it is.
 */
export function readClaudeUnfinishedTurnWords(stdout: string): string | null {
  const messages = readClaudeMessages(stdout);
  if (!messages?.some(message => message.type === 'result')) return null;
  const words: string[] = [];
  for (const message of messages) {
    if (message.type === 'assistant' && isRecord(message.message) && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') words.push(block.text);
      }
    }
    if (message.type === 'result') {
      if (typeof message.result === 'string') words.push(message.result);
      if (Array.isArray(message.errors)) words.push(...message.errors.map(error => typeof error === 'string' ? error : JSON.stringify(error)));
    }
  }
  return wholeText(...words);
}

/** The parts that have any text, a blank line apart. Nothing is cut: only whitespace at the end of a part is dropped. */
function wholeText(...parts: string[]): string {
  return parts.filter(part => part.trim() !== '').map(part => part.trimEnd()).join('\n\n');
}

function exitedSentence(toolName: string, exitCode: number | null): string {
  return exitCode === null ? `${toolName} was ended by a signal before it finished.` : `${toolName} exited with code ${exitCode}.`;
}

function readClaudeOutcome(result: CommandResult, toolName: string): TurnOutcome {
  const turn = readClaudeResult(result.stdout);
  if (result.exitCode !== 0) {
    // A failure inside the run, such as a missing login, exits non-zero and prints the failure as the result on stdout
    // (headless docs, "Basic usage"): show that result's own words. Anything else: everything the tool printed.
    if (turn?.isError) {
      return { state: 'failed', failureText: wholeText(exitedSentence(toolName, result.exitCode), turn.replyText, result.stderr), deniedToolCallCount: turn.deniedToolCallCount };
    }
    return { state: 'failed', failureText: wholeText(exitedSentence(toolName, result.exitCode), result.stderr, result.stdout) };
  }
  if (!turn) {
    return { state: 'failed', failureText: wholeText(`${toolName} finished, but what it printed is not the JSON result this reads. All of it:`, result.stdout, result.stderr) };
  }
  if (turn.isError) return { state: 'failed', failureText: wholeText(`${toolName} reported an error.`, turn.replyText), deniedToolCallCount: turn.deniedToolCallCount };
  return { state: 'replied', replyText: turn.replyText, deniedToolCallCount: turn.deniedToolCallCount };
}

function readCodexOutcome(result: CommandResult, toolName: string): TurnOutcome {
  if (result.exitCode !== 0) return { state: 'failed', failureText: wholeText(exitedSentence(toolName, result.exitCode), result.stderr, result.stdout) };
  // `codex exec` prints only the final message on stdout; its progress goes to stderr.
  return { state: 'replied', replyText: result.stdout.trim() };
}

/**
 * What Claude Code 2.1.325 printed when Stop reached it, in real runs on 15 Nov 2026: a turn that had finished first
 * prints its result as usual, `is_error: false` with the reply. A turn stopped while writing its reply prints a result
 * with `is_error: true`, subtype `error_during_execution` and no `result`, after an assistant message holding what it
 * had written. Stopped while a tool ran, it printed nothing in one run, and in another a result with no `result` and an
 * `errors` list. Each exited 0, so only the result tells them apart.
 */
function readStoppedClaudeOutcome(result: CommandResult): TurnOutcome {
  const turn = readClaudeResult(result.stdout);
  if (turn && !turn.isError) return { state: 'replied', replyText: turn.replyText, deniedToolCallCount: turn.deniedToolCallCount };
  return { state: 'failed', failureText: wholeText(STOPPED_BY_OWNER_TEXT, readClaudeUnfinishedTurnWords(result.stdout) ?? result.stdout, result.stderr) };
}

/**
 * What codex-cli 0.167.0 did when Stop reached it, in real runs on 15 Nov 2026: a turn stopped before it finished
 * prints "turn interrupted" in its progress on stderr and exits 1, and the owner's wrapper around it exits with
 * Codex's code. Exit code 0 means the turn finished and printed its final message.
 */
function readStoppedCodexOutcome(result: CommandResult, toolName: string): TurnOutcome {
  if (result.exitCode === 0) return readCodexOutcome(result, toolName);
  return { state: 'failed', failureText: wholeText(STOPPED_BY_OWNER_TEXT, result.stderr, result.stdout) };
}

function turnOutcome(tool: ContinuationTool, result: CommandResult, stopRequested: boolean): TurnOutcome {
  // Only a command that never started sets spawnError; a stopped one reports how it ended like any other.
  if (result.spawnError) return { state: 'failed', failureText: `${tool.toolName} could not start: ${result.spawnError.message}` };
  return stopRequested ? tool.readStoppedOutcome(result, tool.toolName) : tool.readOutcome(result, tool.toolName);
}

interface ConversationTurns {
  /** Every exchange sent to the conversation from My Work since the worker started, oldest first. */
  exchanges: ConversationContinuation[];
  /** Present while one of them is running: Stop aborts it. */
  runningTurnController?: AbortController;
}

const conversationKeyFor = (platform: string, conversationSessionId: string) => `${platform}:${conversationSessionId}`;

export class ConversationContinuationRunner {
  /**
   * Each conversation's exchanges, keyed by `platform:conversationSessionId`. It grows by one exchange for each message
   * the owner types and sends from My Work by hand since the worker started. Human typing bounds it, so it has no cap.
   * It is never written to disk: a worker restart forgets it, and the turns themselves stay in the conversation.
   */
  private readonly conversations = new Map<string, ConversationTurns>();
  /** Conversations whose start is still checking the CLI's install and login, so a second start cannot slip in meanwhile. */
  private readonly conversationKeysBeingStarted = new Set<string>();
  /**
   * Conversations being opened in their app now, from the CLI's install check until its command has exited (openInApp),
   * each with what stops its command (stopOpeningInApp). One entry per open the owner clicked that is still running.
   */
  private readonly openingsInApp = new Map<string, AbortController>();
  private nextExchangeId = 1;
  private readonly dependencies: ConversationContinuationDependencies;

  constructor(dependencies: ConversationContinuationDependencies) {
    this.dependencies = dependencies;
  }

  /** Whether this conversation can be continued from here, and where its turn would run. Runs no agent detection. */
  target(platform: string, conversationSessionId: string): ConversationContinuationTarget {
    return resolveConversationContinuationTarget(platform, conversationSessionId, this.dependencies);
  }

  /** The exchanges sent to this conversation from My Work since the worker started, oldest first. */
  exchanges(platform: string, conversationSessionId: string): ConversationContinuation[] {
    return [...(this.conversations.get(conversationKeyFor(platform, conversationSessionId))?.exchanges ?? [])];
  }

  /**
   * Sends the owner's message to the conversation as one turn, and answers with the running exchange without waiting
   * for the turn to end; `onChange` hears it again when it ends. A refusal starts nothing.
   */
  async start(platform: string, conversationSessionId: string, ownerMessage: string): Promise<ConversationExchangeOrRefusal> {
    const conversationKey = conversationKeyFor(platform, conversationSessionId);
    // One turn per conversation at a time. Claude Code's sessions docs ("Branch a session"): when two `claude -p` runs
    // resume the same session at once, both write to one transcript, and messages from one of them can be missing.
    if (this.conversations.get(conversationKey)?.runningTurnController || this.conversationKeysBeingStarted.has(conversationKey)) {
      return { refusalText: STILL_RUNNING_REFUSAL };
    }
    if (!ownerMessage.trim()) return { refusalText: EMPTY_MESSAGE_REFUSAL };
    const target = resolveConversationContinuationTarget(platform, conversationSessionId, this.dependencies);
    if (!target.canContinue) return { refusalText: target.refusalText };
    // resolveConversationContinuationTarget refused every other platform.
    const continuablePlatform = platform as ContinuablePlatform;
    const tool = CONTINUATION_TOOLS[continuablePlatform];

    this.conversationKeysBeingStarted.add(conversationKey);
    let agent: UsableAgent | undefined;
    try {
      agent = (await this.dependencies.detectAgents()).find(candidate => candidate.id === tool.agentId);
    } finally {
      this.conversationKeysBeingStarted.delete(conversationKey);
    }
    if (!agent?.path) return { refusalText: `${tool.toolName} is not installed on this computer.` };
    if (!agent.authenticated) return { refusalText: `${tool.toolName} is not logged in on this computer (${agent.reason}).` };

    const exchange: ConversationContinuation = {
      exchangeId: this.nextExchangeId++,
      platform: continuablePlatform,
      conversationSessionId,
      state: 'running',
      ownerMessage,
      startedAtEpochMs: Date.now(),
      ranInFolder: target.runsInFolder,
    };
    const runningTurnController = new AbortController();
    const conversation = this.conversations.get(conversationKey) ?? { exchanges: [] };
    conversation.exchanges.push(exchange);
    conversation.runningTurnController = runningTurnController;
    this.conversations.set(conversationKey, conversation);
    logger.info('WORKER', 'Conversation continuation started', {
      platform, conversationSessionId, exchangeId: exchange.exchangeId, ranInFolder: exchange.ranInFolder, recordedFolderIsGone: target.recordedFolderIsGone,
    });
    void this.runTurn(conversation, exchange, tool, agent.path, runningTurnController).catch(error =>
      logger.error('WORKER', 'Conversation continuation could not report how its turn ended', { platform, conversationSessionId, exchangeId: exchange.exchangeId }, error));
    return { exchange };
  }

  /**
   * Asks the running turn to end: SIGINT, which ends a Claude Code turn cleanly (headless docs, "Stop a run with
   * SIGTERM"), sent on macOS and Linux to the CLI's whole process group, so it also reaches a CLI behind a launcher
   * script (see runCommand). The exchange stays `running` until the command has exited, so no second turn can start
   * while the first is still writing. Then it ends by how the command ended: with its reply when the turn had finished
   * before the stop reached it, otherwise `failed` with "You stopped this turn." and what the turn had printed.
   */
  stop(platform: string, conversationSessionId: string): ConversationExchangeOrRefusal {
    const conversation = this.conversations.get(conversationKeyFor(platform, conversationSessionId));
    const runningExchange = conversation?.exchanges.find(exchange => exchange.state === 'running');
    if (!conversation?.runningTurnController || !runningExchange) return { refusalText: NOTHING_RUNNING_REFUSAL };
    conversation.runningTurnController.abort();
    logger.info('WORKER', 'Conversation continuation stop requested', { platform, conversationSessionId, exchangeId: runningExchange.exchangeId });
    return { exchange: runningExchange };
  }

  /**
   * Opens the conversation in its tool's own app (OPEN_IN_APP_ARGUMENTS), from the folder its turn would run in, through
   * the pseudo-terminal its CLI needs (PSEUDO_TERMINAL_COMMAND), and answers once the command has exited, with what it
   * printed. It starts no turn, changes no exchange, and runs nothing later. Only the CLI's install is checked first:
   * when the app is missing or the login cannot open it, the CLI's own words say so.
   *
   * It has no deadline. It ends when its command exits, or when stopOpeningInApp stops it because the page that asked is
   * going away. One open per conversation runs at a time, so a click in another tab cannot start a second one beside a
   * first that hangs.
   */
  async openInApp(platform: string, conversationSessionId: string): Promise<OpenedInAppOrRefusal> {
    if (isContinuablePlatform(platform) && !opensInItsOwnApp(platform)) {
      return { refusalText: `${CONTINUATION_TOOLS[platform].toolName} has no documented way to open a conversation in its app. Copy the resume command instead.` };
    }
    const target = resolveConversationContinuationTarget(platform, conversationSessionId, this.dependencies);
    if (!target.canContinue) return { refusalText: target.refusalText };
    // The target refused every tool this cannot continue, and the check above every tool without an app of its own.
    const platformWithApp = platform as PlatformWithItsOwnApp;
    const tool = CONTINUATION_TOOLS[platformWithApp];
    const appName = CONVERSATION_APP_NAMES[platformWithApp];
    if (target.opensInAppNamed === null) {
      return { refusalText: `${tool.toolName} opens a conversation in the ${appName} app from here only on macOS. Copy the resume command instead.` };
    }
    const conversationKey = conversationKeyFor(platform, conversationSessionId);
    // Checked and taken before the first await, so two clicks at once cannot both pass.
    if (this.openingsInApp.has(conversationKey)) {
      return {
        refusalText: `${tool.toolName} is still opening this conversation in the ${appName} app from an earlier click. Wait for it to finish, or reload the page you clicked it in to stop it.`,
      };
    }
    const opening = new AbortController();
    this.openingsInApp.set(conversationKey, opening);
    try {
      return await this.runOpenInApp(platformWithApp, conversationSessionId, target.runsInFolder, opening.signal);
    } finally {
      this.openingsInApp.delete(conversationKey);
    }
  }

  /**
   * Stops the command opening this conversation in its app, which then answers that it was stopped. The page asks for this
   * when it is unloaded while its open still runs (a reload, a closed tab), because the worker cannot see that page's
   * request go away: Bun's node:http, which serves the worker, gives a POST whose client has left no event, no error and
   * no failed write (Bun 1.3.9, checked with raw TCP clients on 15 Nov 2026; Node sees it at once). runCommand sends
   * SIGTERM to script's process group, script ends, its pseudo-terminal closes, and the CLI behind it gets the hangup
   * (SIGHUP) a closed terminal window gives it.
   */
  stopOpeningInApp(platform: string, conversationSessionId: string): { stopping: true } | { refusalText: string } {
    const opening = this.openingsInApp.get(conversationKeyFor(platform, conversationSessionId));
    if (!opening) return { refusalText: 'Nothing is opening this conversation in its app.' };
    opening.abort();
    logger.info('WORKER', 'Conversation open in its app stop requested: the page that asked is going away', { platform, conversationSessionId });
    return { stopping: true };
  }

  private async runOpenInApp(
    platform: PlatformWithItsOwnApp,
    conversationSessionId: string,
    runsInFolder: string,
    stopRequested: AbortSignal,
  ): Promise<OpenedInAppOrRefusal> {
    const tool = CONTINUATION_TOOLS[platform];
    const agent = (await this.dependencies.detectAgents()).find(candidate => candidate.id === tool.agentId);
    if (!agent?.path) return { refusalText: `${tool.toolName} is not installed on this computer.` };
    const didNotOpen = `${tool.toolName} could not open this conversation in the ${CONVERSATION_APP_NAMES[platform]} app`;
    const stoppedSentence = `${didNotOpen}: the page that asked went away, so it was stopped.`;
    if (stopRequested.aborted) {
      logger.info('WORKER', 'Conversation open in its app not started: the page that asked went away while the CLI was checked', { platform, conversationSessionId });
      return { refusalText: stoppedSentence };
    }

    const scriptArguments = ['-q', '/dev/null', agent.path, ...OPEN_IN_APP_ARGUMENTS[platform](conversationSessionId)];
    // Nothing is written to its stdin: runCommand gives a command no stdin when it has no input. The stop is SIGTERM to
    // script's process group: the open starts no turn, so unlike a turn's Stop (SIGINT) it leaves nothing unfinished.
    const result = await runCommand(this.dependencies.spawnImpl, PSEUDO_TERMINAL_COMMAND, scriptArguments, {
      cwd: runsInFolder, env: { ...this.childEnvironment(), TERM: 'dumb' }, signal: stopRequested, killSignal: 'SIGTERM',
    });
    // What the CLI printed on stdout and stderr arrives together on script's stdout; script's stderr holds script's own.
    const printedText = wholeText(printedThroughPseudoTerminal(result.stdout), result.stderr);
    logger.info('WORKER', 'Conversation open in its app ended', {
      platform, conversationSessionId, ranInFolder: runsInFolder, exitCode: result.exitCode, spawnError: result.spawnError?.message,
      stopRequested: stopRequested.aborted, printedText,
    });
    if (result.spawnError) return { refusalText: `${didNotOpen}: ${result.spawnError.message}` };
    // An exit 0 opened it, even when a stop came after the command had finished.
    if (result.exitCode === 0) return { opened: true, printedText: printedText === '' ? null : printedText };
    if (stopRequested.aborted) return { refusalText: wholeText(stoppedSentence, printedText) };
    return { refusalText: wholeText(`${didNotOpen}. ${exitedSentence(tool.toolName, result.exitCode)}`, printedText) };
  }

  /**
   * The environment a CLI started from here gets: the worker's, cleaned. The worker's own Claude Code session variables
   * and its "internal run" mark must not reach the owner's conversation: CLAUDE_MEM_INTERNAL=1 would keep claude-mem's
   * hooks from capturing the turn.
   */
  private childEnvironment(): NodeJS.ProcessEnv {
    const { CLAUDE_MEM_INTERNAL: _internalRunMark, ...childEnvironment } = sanitizeEnv(this.dependencies.environment?.() ?? process.env);
    return childEnvironment;
  }

  private async runTurn(
    conversation: ConversationTurns,
    exchange: ConversationContinuation,
    tool: ContinuationTool,
    executablePath: string,
    runningTurnController: AbortController,
  ): Promise<void> {
    const result = await runCommand(this.dependencies.spawnImpl, executablePath, tool.argumentsFor(exchange.conversationSessionId), {
      cwd: exchange.ranInFolder,
      env: this.childEnvironment(),
      input: exchange.ownerMessage,
      signal: runningTurnController.signal,
      // SIGINT ends the turn; SIGTERM would leave it unfinished (headless docs, "Stop a run with SIGTERM").
      killSignal: 'SIGINT',
    });
    const ended: ConversationContinuation = {
      ...exchange,
      ...turnOutcome(tool, result, runningTurnController.signal.aborted),
      endedAtEpochMs: Date.now(),
    };
    conversation.exchanges = conversation.exchanges.map(candidate => candidate.exchangeId === ended.exchangeId ? ended : candidate);
    delete conversation.runningTurnController;
    logger.info('WORKER', 'Conversation continuation ended', {
      platform: ended.platform, conversationSessionId: ended.conversationSessionId, exchangeId: ended.exchangeId, state: ended.state,
    });
    this.dependencies.onChange(ended);
  }
}
