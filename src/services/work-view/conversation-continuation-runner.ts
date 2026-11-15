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
 * The argv shapes, the UUID guard, the stdin delivery and dropping CLAUDE_MEM_INTERNAL follow Miles Wiesenthal's
 * answer-delivery.ts in PR #6054.
 */
import type { spawn } from 'child_process';
import { statSync } from 'fs';
import { dirname } from 'path';
import { runCommand, type CommandResult, type UsableAgent, type UsableAgentId } from '../agent-runner/detect.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { logger } from '../../utils/logger.js';
import {
  CONVERSATION_SESSION_UUID_PATTERN,
  isContinuablePlatform,
  type ContinuablePlatform,
  type ConversationContinuation,
  type ConversationContinuationTarget,
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
}

/** A start or a stop: the exchange it concerns, or one sentence saying why it did not happen. */
export type ConversationExchangeOrRefusal = { exchange: ConversationContinuation } | { refusalText: string };

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
 * It runs no agent detection: the page asks this for every conversation row the owner opens.
 */
export function resolveConversationContinuationTarget(
  platform: string,
  conversationSessionId: string,
  dependencies: Pick<ConversationContinuationDependencies, 'recordedFolderForConversation' | 'isExistingFolder'>,
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
  try {
    if (folderExists(recordedFolder)) return { canContinue: true, recordedFolder, runsInFolder: recordedFolder, recordedFolderIsGone: false };
    for (let candidate = dirname(recordedFolder); ; candidate = dirname(candidate)) {
      if (folderExists(candidate)) return { canContinue: true, recordedFolder, runsInFolder: candidate, recordedFolderIsGone: true };
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

  private async runTurn(
    conversation: ConversationTurns,
    exchange: ConversationContinuation,
    tool: ContinuationTool,
    executablePath: string,
    runningTurnController: AbortController,
  ): Promise<void> {
    // The worker's own Claude Code session variables and its "internal run" mark must not reach the owner's
    // conversation: CLAUDE_MEM_INTERNAL=1 would keep claude-mem's hooks from capturing the turn.
    const { CLAUDE_MEM_INTERNAL: _internalRunMark, ...childEnvironment } = sanitizeEnv(this.dependencies.environment?.() ?? process.env);
    const result = await runCommand(this.dependencies.spawnImpl, executablePath, tool.argumentsFor(exchange.conversationSessionId), {
      cwd: exchange.ranInFolder,
      env: childEnvironment,
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
