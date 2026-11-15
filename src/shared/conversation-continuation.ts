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
 * The `conversation-continuation` event on the worker's event stream (/api/work-view/events), sent when an exchange
 * starts and when it ends: which exchange of which conversation, and its state, and nothing else. The stream checks no
 * origin, and the worker's CORS lets a page on any http://localhost or http://127.0.0.1 port read it (local API token
 * mode, which would stop that, is off by default). So the message, the reply, the failure text and the folder are only
 * ever answered by the guarded read, GET /api/work-view/conversations/continuation, which the page asks when a notice
 * for a conversation it shows arrives.
 */
export type ConversationContinuationNotice = Pick<ConversationContinuation, 'exchangeId' | 'platform' | 'conversationSessionId' | 'state'>;

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
    /**
     * The app this computer's worker can open the conversation in, by name (CONVERSATION_APP_NAMES), or null when it
     * can't open it in one here: Codex documents no way to, and the worker opens a Claude Code conversation in the
     * Claude app on macOS only (ConversationContinuationRunner.openInApp says why). The page offers "Open in {app}" only
     * when this names one.
     */
    opensInAppNamed: string | null;
  }
  | {
    canContinue: false;
    refusalText: string;
    /** sdk_sessions.cwd, or null when no folder (or no session) is recorded. */
    recordedFolder: string | null;
    runsInFolder?: undefined;
    recordedFolderIsGone?: undefined;
    opensInAppNamed?: undefined;
  };

/**
 * Which click an open in its app belongs to: a random UUID the page makes for each click on "Open in {app}"
 * (crypto.randomUUID, so lowercase version 4), sent with the open and with the stop the page asks for as it goes away.
 * The worker stops an open only for the click that started it, so the stop from another tab's click, refused while this
 * open ran, or a late stop from an earlier click, never stops the open running now. The page makes the id because the
 * open answers only once its command has exited, too late to carry an id the worker made.
 */
export const OPEN_IN_APP_CLICK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * What POST /api/work-view/conversations/open-in-app answers once the conversation is open in its app: what the CLI
 * printed as it opened it, without the terminal's control sequences, or null when it printed nothing. The page shows
 * it under the row, so an open that printed something unexpected is never silent.
 */
export interface ConversationOpenedInApp {
  printedText: string | null;
}

/**
 * The app each tool opens one of its conversations in, by name, or null when the tool documents no way to. Claude Code
 * opens one in the Claude desktop app with `claude --desktop --resume <session uuid>` (desktop docs, "Coming from the
 * CLI?"; `--desktop` in `claude --help` 2.1.325), which the worker runs (ConversationContinuationRunner.openInApp).
 * Codex documents no link and no flag for its app, so a Codex row offers the resume command only, and the worker refuses
 * to open one. Whether this computer can open one is the worker's to say: the target's opensInAppNamed.
 */
export const CONVERSATION_APP_NAMES = { claude: 'Claude', codex: null } as const satisfies Record<ContinuablePlatform, string | null>;

/** A tool that opens its conversations in its own app: one whose CONVERSATION_APP_NAMES entry is a name. */
export type PlatformWithItsOwnApp = {
  [Platform in ContinuablePlatform]: (typeof CONVERSATION_APP_NAMES)[Platform] extends string ? Platform : never;
}[ContinuablePlatform];

export function opensInItsOwnApp(platform: ContinuablePlatform): platform is PlatformWithItsOwnApp {
  return CONVERSATION_APP_NAMES[platform] !== null;
}

const RESUME_COMMAND_WORDS: Record<ContinuablePlatform, string> = { claude: 'claude --resume', codex: 'codex resume' };

/**
 * The interactive command that resumes this conversation in a terminal, from any folder, or null when it cannot be
 * resumed. Built from fixed words and the checked UUID only, so no recorded text ever reaches a shell.
 */
export function resumeCommandFor(platform: string, conversationSessionId: string): string | null {
  if (!isContinuablePlatform(platform) || !CONVERSATION_SESSION_UUID_PATTERN.test(conversationSessionId)) return null;
  return `${RESUME_COMMAND_WORDS[platform]} ${conversationSessionId}`;
}
