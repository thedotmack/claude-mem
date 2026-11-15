/**
 * Continuing a conversation from My Work: the owner types a message under a Claude Code or Codex conversation in a
 * request's "Where this came from" row, that same conversation takes it as one headless turn, and the reply is shown
 * there. The worker (services/work-view/conversation-continuation-runner.ts) and My Work both load this module, so it
 * has no Node imports (setup-funnel.ts is the model). Each list and type below has its one definition here: request
 * checks, the page's types and its wording tables take them from here and never type the values again.
 */

/** The tools a conversation can be continued in, by the platform its conversation key records (sdk_sessions.platform_source). */
export const CONTINUABLE_PLATFORMS = ['claude', 'codex'] as const;
export type ContinuablePlatform = (typeof CONTINUABLE_PLATFORMS)[number];

export function isContinuablePlatform(platform: unknown): platform is ContinuablePlatform {
  return typeof platform === 'string' && (CONTINUABLE_PLATFORMS as readonly string[]).includes(platform);
}

/**
 * The state of one exchange. Its one writer is ConversationContinuationRunner
 * (services/work-view/conversation-continuation-runner.ts):
 *
 *   (none) ──► running ──► replied
 *                      └─► failed      (refused by the tool, exited non-zero, unreadable output, or stopped by the owner)
 *
 * Exchanges live in the worker's memory only. A worker restart forgets them; the turns stay in the conversation.
 */
export const CONVERSATION_CONTINUATION_STATES = ['running', 'replied', 'failed'] as const;
export type ConversationContinuationState = (typeof CONVERSATION_CONTINUATION_STATES)[number];

/** A session id both CLIs resume by: a UUID, 8-4-4-4-12 hex digits. */
export const CONVERSATION_SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One exchange: one message the owner sent from My Work to a conversation, and what came back. */
export interface ConversationContinuation {
  /** Unique within the worker's life: how the page matches a pushed update to the exchange it already shows. */
  exchangeId: number;
  platform: ContinuablePlatform;
  conversationSessionId: string;
  state: ConversationContinuationState;
  ownerMessage: string;
  startedAtEpochMs: number;
  /** Set once the exchange is `replied` or `failed`. */
  endedAtEpochMs?: number;
  /** The conversation's reply, whole. Set when `replied`. */
  replyText?: string;
  /** Why the turn did not finish, whole. Set when `failed`. */
  failureText?: string;
  /** Tool calls the turn was not allowed to make. Set when the tool reported them (Claude Code does; Codex does not). */
  deniedToolCallCount?: number;
  /** The folder the turn ran in. */
  ranInFolder: string;
}

/**
 * Whether a conversation can be continued from here and where its turn would run. A refusal is one sentence the page
 * shows as it is. The fields the other branch lacks are typed `undefined`, so a reader may check any of them unnarrowed.
 */
export type ConversationContinuationTarget =
  | {
    canContinue: true;
    refusalText?: undefined;
    /** sdk_sessions.cwd: the folder the conversation was started in. */
    recordedFolder: string;
    /** The recorded folder, or, when it is gone, the nearest folder above it that still exists. */
    runsInFolder: string;
    recordedFolderIsGone: boolean;
  }
  | {
    canContinue: false;
    refusalText: string;
    /** sdk_sessions.cwd, or null when no folder (or no session) is recorded. */
    recordedFolder: string | null;
    runsInFolder?: undefined;
    recordedFolderIsGone?: undefined;
  };

const RESUME_COMMAND_WORDS: Record<ContinuablePlatform, string> = { claude: 'claude --resume', codex: 'codex resume' };

/**
 * The interactive command that resumes this conversation in a terminal, from any folder, or null when it cannot be
 * resumed. Built from fixed words and the checked UUID only, so no recorded text ever reaches a shell.
 */
export function resumeCommandFor(platform: string, conversationSessionId: string): string | null {
  if (!isContinuablePlatform(platform) || !CONVERSATION_SESSION_UUID_PATTERN.test(conversationSessionId)) return null;
  return `${RESUME_COMMAND_WORDS[platform]} ${conversationSessionId}`;
}
