// Continuing a conversation from My Work, as the page sees it: which conversation rows can offer it, what a row shows,
// and how the worker's answers are read. The row component draws it and local-source.ts makes the calls. No React and
// relative .ts imports, so `node --test` loads it. The platforms, the states and the session id pattern are the shared
// module's (src/shared/conversation-continuation.ts); nothing here types them again.
import {
  CONVERSATION_CONTINUATION_STATES,
  CONVERSATION_SESSION_UUID_PATTERN,
  isContinuablePlatform,
  type ContinuablePlatform,
  type ConversationContinuation,
  type ConversationContinuationNotice,
  type ConversationContinuationState,
  type ConversationContinuationTarget,
} from '../../../../shared/conversation-continuation.ts'
import type { Request } from '../data.ts'
import type { ConversationContinuationEvent, ConversationContinuationRead } from './work-data-source.ts'

/** Which conversation a row is: the platform and session id its conversation key records. */
type ConversationIdentity = Pick<Request['conversations'][number], 'platform' | 'conversationSessionId'>

/**
 * Whether a row can offer to continue its conversation: Claude Code or Codex, with a session id its CLI resumes (a
 * UUID). Any other row, sample rows included, says in one line that it can't, without asking the worker.
 */
export function isContinuableConversation<Conversation extends ConversationIdentity>(
  conversation: Conversation,
): conversation is Conversation & { platform: ContinuablePlatform } {
  return isContinuablePlatform(conversation.platform) && CONVERSATION_SESSION_UUID_PATTERN.test(conversation.conversationSessionId)
}

/** Whether a row showing this conversation must read it again: a notice about one of its exchanges, or a reopened stream. */
export function continuationEventConcernsConversation(event: ConversationContinuationEvent, conversation: ConversationIdentity): boolean {
  return event === 'live-updates-reconnected'
    || (event.platform === conversation.platform && event.conversationSessionId === conversation.conversationSessionId)
}

// ---- What a row shows

/** Words for the owner: `english` is the sentence and its i18n catalog key, and `values` fill its {placeholders}. */
export interface ContinuationWords { english: string; values: Record<string, string | number> }

/** How each state of an exchange is worded. A new state fails the typecheck here until it has words. */
export const CONTINUATION_STATE_WORDS: Record<ConversationContinuationState, string> = {
  running: 'Working…',
  replied: 'Replied',
  failed: 'Did not finish',
}

/** Codex can finish (exit 0) and print nothing, so an empty success says so instead of showing nothing. */
const NO_WRITTEN_REPLY: ContinuationWords = { english: 'It finished without a written reply.', values: {} }

/** A headless turn has no one to ask, so a tool call that needs approval is denied, and Claude Code counts it. */
function deniedToolCallWords(deniedToolCallCount: number): ContinuationWords {
  return {
    english: deniedToolCallCount === 1
      ? '{count} tool call was not allowed in this turn. Open the conversation to approve it.'
      : '{count} tool calls were not allowed in this turn. Open the conversation to approve them.',
    values: { count: deniedToolCallCount },
  }
}

/** One exchange as its row shows it. */
export interface ConversationExchangeView {
  exchangeId: number
  ownerMessage: string
  state: ConversationContinuationState
  /** CONTINUATION_STATE_WORDS for its state. */
  stateWords: string
  /** The reply, whole. Null unless it replied with words. */
  replyText: string | null
  /** Why the turn did not finish, whole. Null unless it failed. */
  failureText: string | null
  /** Said under it, in this order: a reply with no words, tool calls the turn was not allowed to make. */
  notices: ContinuationWords[]
}

/** One conversation row, as its worker read and the message typed in its box make it. */
export interface ConversationContinuationView {
  /** The worker's sentence when this conversation can't be continued from here. The row shows it muted, and no box. */
  refusalText: string | null
  /** Shown above the box, before anything is sent, when the recorded folder is gone: where the turn will run instead. */
  folderGoneNotice: ContinuationWords | null
  /** Whether the box and Send are shown. */
  composerIsShown: boolean
  /** Whether Send can be pressed: the box is shown, no turn sent from here is running, and the message has words. */
  sendIsEnabled: boolean
  /** Whether Stop is shown, on the running exchange. Also when the box is not: a running turn can always be stopped. */
  stopIsShown: boolean
  /** The exchanges sent from My Work since the worker started, oldest first, as the worker listed them. */
  exchanges: ConversationExchangeView[]
}

/**
 * What a conversation row shows. Every text is passed on whole: nothing here shortens the owner's message, a reply,
 * a failure or the folder.
 */
export function continuationView(
  target: ConversationContinuationTarget,
  exchanges: ConversationContinuation[],
  typedMessage: string,
): ConversationContinuationView {
  const aTurnIsRunning = exchanges.some((exchange) => exchange.state === 'running')
  return {
    refusalText: target.canContinue ? null : target.refusalText,
    folderGoneNotice: target.canContinue && target.recordedFolderIsGone
      ? { english: 'Its folder is gone, so this turn will run in {folder}.', values: { folder: target.runsInFolder } }
      : null,
    composerIsShown: target.canContinue,
    // The worker trims the message and refuses one with no words, so Send waits for words.
    sendIsEnabled: target.canContinue && !aTurnIsRunning && typedMessage.trim() !== '',
    stopIsShown: aTurnIsRunning,
    exchanges: exchanges.map(exchangeView),
  }
}

function exchangeView(exchange: ConversationContinuation): ConversationExchangeView {
  const replyText = exchange.state === 'replied' && exchange.replyText?.trim() ? exchange.replyText : null
  const deniedToolCallCount = exchange.deniedToolCallCount ?? 0
  const notices: ContinuationWords[] = []
  if (exchange.state === 'replied' && replyText === null) notices.push(NO_WRITTEN_REPLY)
  if (deniedToolCallCount > 0) notices.push(deniedToolCallWords(deniedToolCallCount))
  return {
    exchangeId: exchange.exchangeId,
    ownerMessage: exchange.ownerMessage,
    state: exchange.state,
    stateWords: CONTINUATION_STATE_WORDS[exchange.state],
    replyText,
    failureText: exchange.state === 'failed' && exchange.failureText ? exchange.failureText : null,
    notices,
  }
}

// ---- Reading the worker's answers

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isConversationContinuationState = (value: unknown): value is ConversationContinuationState =>
  (CONVERSATION_CONTINUATION_STATES as readonly unknown[]).includes(value)
const isAbsentOr = (value: unknown, type: 'string' | 'number') => value === undefined || typeof value === type

function isConversationContinuation(value: unknown): value is ConversationContinuation {
  return isRecord(value) && typeof value.exchangeId === 'number' && isContinuablePlatform(value.platform)
    && typeof value.conversationSessionId === 'string' && isConversationContinuationState(value.state)
    && typeof value.ownerMessage === 'string' && typeof value.startedAtEpochMs === 'number' && typeof value.ranInFolder === 'string'
    && isAbsentOr(value.endedAtEpochMs, 'number') && isAbsentOr(value.replyText, 'string') && isAbsentOr(value.failureText, 'string')
    && isAbsentOr(value.deniedToolCallCount, 'number')
}

function isConversationContinuationTarget(value: unknown): value is ConversationContinuationTarget {
  if (!isRecord(value)) return false
  if (value.canContinue === true) {
    return typeof value.recordedFolder === 'string' && typeof value.runsInFolder === 'string' && typeof value.recordedFolderIsGone === 'boolean'
  }
  return value.canContinue === false && typeof value.refusalText === 'string'
    && (value.recordedFolder === null || typeof value.recordedFolder === 'string')
}

/** The guarded read's answer about one conversation, or null when the body is not one. */
export function readConversationContinuationAnswer(body: unknown): ConversationContinuationRead | null {
  if (!isRecord(body)) return null
  const { target, exchanges } = body
  if (!isConversationContinuationTarget(target) || !Array.isArray(exchanges) || !exchanges.every(isConversationContinuation)) return null
  return { target, exchanges }
}

/** The exchange a continue or stop answers with, or null when the body carries none. */
export function readConversationExchangeAnswer(body: unknown): ConversationContinuation | null {
  return isRecord(body) && isConversationContinuation(body.exchange) ? body.exchange : null
}

/** The notice a `conversation-continuation` frame carries, with its four fields only, or null when it is not one. */
export function readConversationContinuationNotice(frame: Record<string, unknown>): ConversationContinuationNotice | null {
  const { exchangeId, platform, conversationSessionId, state } = frame
  return typeof exchangeId === 'number' && isContinuablePlatform(platform) && typeof conversationSessionId === 'string'
    && isConversationContinuationState(state)
    ? { exchangeId, platform, conversationSessionId, state }
    : null
}

/** validateBody's issues as words: "ownerMessage: Too small: …", one per issue. Null when they can't be read. */
function validationIssueWords(issues: unknown): string | null {
  if (!Array.isArray(issues) || issues.length === 0) return null
  const words: string[] = []
  for (const issue of issues) {
    if (!isRecord(issue) || typeof issue.message !== 'string') return null
    const field = Array.isArray(issue.path) ? issue.path.join('.') : ''
    words.push(field ? `${field}: ${issue.message}` : issue.message)
  }
  return words.join('; ')
}

/**
 * Why a conversation route did not do what was asked, as one plain sentence the row shows as it is. `attemptedAction`
 * completes "Could not …", as in "send your message". The worker's own sentence is used whenever it sent one: a refusal
 * (409), a worker without the runner (503), a guard (403, or 401 in local API token mode, whose sentence is in
 * `message`). A body that is not JSON is never shown: Express answers a message over the worker's 5 MB JSON body limit
 * (express.json in createMiddleware, middleware.ts) with its own HTML page (413).
 */
export function conversationRouteFailureSentence(
  answer: { status: number; statusText: string },
  body: unknown,
  attemptedAction: string,
): string {
  if (answer.status === 413) return `Could not ${attemptedAction}: it is too large for the worker to take.`
  if (isRecord(body)) {
    if (body.error === 'ValidationError') {
      // validateBody answers a failed request check with this code word and the issues, not with a sentence.
      const issues = validationIssueWords(body.issues)
      if (issues) return `Could not ${attemptedAction}: the worker could not read the request (${issues}).`
    } else {
      // The worker-wide guards answer a code word in `error` and their sentence in `message`; the work-view guards and
      // the routes answer their sentence in `error`.
      const sentence = [body.message, body.error].find((text): text is string => typeof text === 'string' && text.trim() !== '')
      if (sentence) return sentence
    }
  }
  return `Could not ${attemptedAction}: the worker answered ${answer.status}${answer.statusText ? ` ${answer.statusText}` : ''}.`
}

/** A call that never got an answer: the worker is not running, or the connection broke. */
export function unreachableWorkerSentence(attemptedAction: string, error: unknown): string {
  return `Could not ${attemptedAction}: the worker could not be reached (${error instanceof Error ? error.message : String(error)}).`
}

/** A success whose body is not what the route sends. It says no more than it knows: a turn may have started. */
export function unreadableAnswerSentence(status: number): string {
  return `The worker answered ${status}, but this page cannot read its answer.`
}
