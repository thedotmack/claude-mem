// Continuing a conversation from My Work, as the page sees it: which conversation rows can offer it, what a row shows,
// and how the worker's answers are read. The row component draws it and local-source.ts makes the calls. No React and
// relative .ts imports, so `node --test` loads it. The platforms, the states and the session id pattern are the shared
// module's (src/shared/conversation-continuation.ts); nothing here types them again.
import {
  CONVERSATION_CONTINUATION_STATES,
  CONVERSATION_SESSION_UUID_PATTERN,
  isContinuablePlatform,
  resumeCommandFor,
  type ContinuablePlatform,
  type ConversationContinuation,
  type ConversationContinuationNotice,
  type ConversationContinuationState,
  type ConversationContinuationTarget,
  type ConversationOpenedInApp,
} from '../../../../shared/conversation-continuation.ts'
import type { Request } from '../data.ts'
import type { ConversationContinuationEvent, ConversationContinuationRead, ConversationContinuationSource, WorkDataSource } from './work-data-source.ts'

/**
 * Whether a source can continue a conversation from this page. Only the page this computer's worker serves has the
 * calls (local-source.ts); the sample source and a cloud-served page leave them out, so their rows show nothing for it.
 */
export function canContinueConversations(source: WorkDataSource): source is ConversationContinuationSource {
  return Boolean(source.loadConversationContinuation && source.continueConversation && source.stopConversationContinuation
    && source.subscribeToConversationContinuations)
}

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

// ---- What a row's controls are called, and where focus goes after Send or Stop

/**
 * The last eight characters of a session id, which tell apart conversations whose titles match. Why eight: they are 32
 * random bits, so two ids share them about once in four billion pairs. Both tools' ids end in random bits: a Claude Code
 * id is a random UUID (version 4), and a Codex id is a time-ordered one (version 7), whose first eight characters are the
 * top bits of the millisecond it started, the same for every id started in the same 65.5 seconds. The title shows those
 * first eight (to-work-model.ts). In one real database on 15 Nov 2026, the last eight told apart all 705 Codex and all
 * 5,792 Claude Code session ids, while the 705 Codex ids had only 565 different first eights.
 */
const SESSION_ID_END = /.{8}$/
const sessionIdEndOf = (conversationSessionId: string) => conversationSessionId.match(SESSION_ID_END)?.[0] ?? conversationSessionId

/** What a row's message box, Send and Stop are called for a screen reader. */
export interface ConversationControlNames { messageBox: ContinuationWords; sendButton: ContinuationWords; stopButton: ContinuationWords }

/**
 * What a row's message box, Send and Stop are called for a screen reader. A request can list several conversations, each
 * with its own Send and Stop, so their names say which conversation they act on: its tool and title, as its line shows
 * them. Each name starts with the word its button shows, "Send" or "Stop", which stays as it is. Codex session ids are
 * time-ordered, so conversations started within a minute share their first characters and the title made from them:
 * when another row shows the same title, each name adds the last eight characters of this session id. The box's label
 * names the tool only, as before.
 */
export function conversationControlNames(conversation: {
  toolName: string
  conversationTitle: string
  conversationSessionId: string
  anotherConversationHasTheSameTitle: boolean
}): ConversationControlNames {
  const { toolName: tool, conversationTitle: title } = conversation
  if (!conversation.anotherConversationHasTheSameTitle) {
    return {
      messageBox: { english: 'Continue this {tool} conversation', values: { tool } },
      sendButton: { english: 'Send to the {tool} conversation “{title}”', values: { tool, title } },
      stopButton: { english: 'Stop the turn in the {tool} conversation “{title}”', values: { tool, title } },
    }
  }
  const sessionIdEnd = sessionIdEndOf(conversation.conversationSessionId)
  return {
    messageBox: { english: 'Continue this {tool} conversation (…{sessionIdEnd})', values: { tool, sessionIdEnd } },
    sendButton: { english: 'Send to the {tool} conversation “{title}” (…{sessionIdEnd})', values: { tool, title, sessionIdEnd } },
    stopButton: { english: 'Stop the turn in the {tool} conversation “{title}” (…{sessionIdEnd})', values: { tool, title, sessionIdEnd } },
  }
}

/** Where focus goes in a conversation's box: its message box, or the box itself. */
export type ConversationFocusTarget = 'message-box' | 'conversation-box'

/**
 * Where keyboard focus goes once Send or Stop is pressed, so the owner keeps their place in that conversation's box. A
 * pressed Send is disabled while its message goes out and while its turn runs; a pressed Stop is disabled until its turn
 * ends, and then it goes away. A pressed button that held focus would drop it to the page, so focus moves to the message
 * box, which stays. A turn sent earlier can still be stopped after its conversation could no longer be continued, and
 * then there is no message box: focus moves to the conversation's box itself. Null when the pressed button did not hold
 * focus, as in a browser that does not focus a clicked button: nothing was lost, so nothing moves.
 */
export function focusAfterSendOrStop(
  pressedButtonHadFocus: boolean,
  view: Pick<ConversationContinuationView, 'composerIsShown'>,
): ConversationFocusTarget | null {
  if (!pressedButtonHadFocus) return null
  return view.composerIsShown ? 'message-box' : 'conversation-box'
}

// ---- Beside Send: open the conversation in its tool's own app, or copy the command that resumes it

/** What a row offers beside Send, and the line under those buttons. */
export interface ConversationAppActionsView {
  /**
   * "Open in {app}" and its button's name, when the worker says it can open the conversation in an app on this computer
   * (the target's opensInAppNamed) and this page can ask it to.
   */
  openInApp: { label: ContinuationWords; buttonName: ContinuationWords } | null
  copyResumeCommand: {
    /** What the button copies: fixed words and the session id (resumeCommandFor). The folder is never part of it. */
    command: string
    buttonName: ContinuationWords
    /** The button's name while it shows "Copied". */
    copiedButtonName: ContinuationWords
  }
  /**
   * Under the buttons while the recorded folder exists: where a turn sent from here runs, and so where to cd before the
   * copied command. When the folder is gone, the notice above the box says where the turn runs instead.
   */
  runsInFolderNotice: ContinuationWords | null
}

/**
 * What a conversation row offers beside Send: "Open in {app}" when the worker says it can open the conversation in an app
 * on this computer (the target's opensInAppNamed: only a Claude Code conversation, and only on macOS) and the page can ask
 * it to, and "Copy resume command" wherever the row shows Send. Null where the row shows no Send, because its
 * conversation can't be continued from here. The buttons are named like Send and Stop (conversationControlNames): the
 * words each shows, then the conversation it acts on, and the end of its session id when another row shows the same title.
 */
export function conversationAppActions(
  conversation: Parameters<typeof conversationControlNames>[0] & { platform: ContinuablePlatform },
  target: ConversationContinuationTarget,
  sourceCanOpenInApp: boolean,
): ConversationAppActionsView | null {
  const command = resumeCommandFor(conversation.platform, conversation.conversationSessionId)
  if (!target.canContinue || command === null) return null
  const { toolName: tool, conversationTitle: title } = conversation
  const sessionIdEnd = conversation.anotherConversationHasTheSameTitle ? sessionIdEndOf(conversation.conversationSessionId) : null
  /** `english`, or, when another row shows the same title, `withSessionIdEnd` with the end of this session id. */
  const named = (english: string, withSessionIdEnd: string, values: Record<string, string>): ContinuationWords =>
    sessionIdEnd === null ? { english, values } : { english: withSessionIdEnd, values: { ...values, sessionIdEnd } }
  const app = target.opensInAppNamed
  return {
    openInApp: app === null || !sourceCanOpenInApp ? null : {
      label: { english: 'Open in {app}', values: { app } },
      buttonName: named('Open in {app}: the {tool} conversation “{title}”', 'Open in {app}: the {tool} conversation “{title}” (…{sessionIdEnd})', { app, tool, title }),
    },
    copyResumeCommand: {
      command,
      buttonName: named('Copy resume command for the {tool} conversation “{title}”',
        'Copy resume command for the {tool} conversation “{title}” (…{sessionIdEnd})', { tool, title }),
      copiedButtonName: named('Copied the resume command for the {tool} conversation “{title}”',
        'Copied the resume command for the {tool} conversation “{title}” (…{sessionIdEnd})', { tool, title }),
    },
    runsInFolderNotice: target.recordedFolderIsGone ? null : { english: 'Runs in {folder}', values: { folder: target.runsInFolder } },
  }
}

/** One of a button's labels, and whether the button shows it now. */
export interface ButtonLabelInPlace { text: string; isShown: boolean }

/**
 * What a button whose label changes while it works lays out: its label and its working label, both in one place, with only
 * the one for now shown. The button is then as wide in both states as its wider label, so the buttons after it in the row
 * never move when its label changes: "Opening…" is narrower than "Open in Claude", and "Sending…" wider than "Send".
 */
export function buttonLabelsKeepingTheirWidth(label: string, workingLabel: string, isWorking: boolean): ButtonLabelInPlace[] {
  return [{ text: label, isShown: !isWorking }, { text: workingLabel, isShown: isWorking }]
}

/**
 * What the row says when the clipboard did not take the resume command, as two lines above the command shown to copy by
 * hand: why, then where to copy it from. The reason is the browser's, whole, and ends its line as it is: a reason often
 * ends with its own full stop ("Write permission denied."), so nothing is put after it.
 */
export function resumeCommandCopyFailureWords(reason: string): { why: ContinuationWords; copyItFromHere: ContinuationWords } {
  return {
    why: { english: 'Could not copy the command: {reason}', values: { reason } },
    copyItFromHere: { english: 'Copy it from here:', values: {} },
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
      && (value.opensInAppNamed === null || typeof value.opensInAppNamed === 'string')
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

/** What the open-in-app route answers once the app opened the conversation: what the CLI printed. Null otherwise. */
export function readOpenedInAppAnswer(body: unknown): ConversationOpenedInApp | null {
  if (!isRecord(body) || !(body.printedText === null || typeof body.printedText === 'string')) return null
  return { printedText: body.printedText }
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
