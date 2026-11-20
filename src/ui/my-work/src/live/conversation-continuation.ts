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
import { legacyUntitledConversationTitle } from './to-work-model.ts'
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

/** A conversation's key among the conversations a request lists: its platform and session id. */
export const conversationKey = (conversation: ConversationIdentity) => JSON.stringify([conversation.platform, conversation.conversationSessionId])

/**
 * Which conversation the reply card answers when it opens (c-conversation-continue; plan decision G19): the first listed
 * that this page can offer to continue, else the first listed. The plan's choice is the latest by activity time where
 * the data has one; no worker sends a conversation's activity time yet (a request carries its conversation keys alone,
 * work-view-api-types.ts WorkViewHumanRequest), so the order the worker lists them in decides.
 */
export function defaultReplyConversation<Conversation extends ConversationIdentity>(conversations: readonly Conversation[]): Conversation | undefined {
  return conversations.find((conversation) => isContinuableConversation(conversation)) ?? conversations[0]
}

/** How a conversation is named on its row and in the reply card's picker (conversationNaming). */
export interface ConversationNaming {
  /** The recorded title; null when none is recorded, and the row says "{tool} conversation" instead. */
  recordedTitle: string | null
  tool: string
  /** The small monospace chip that tells it from the others: the session id's first eight characters, or "…" and its last eight. */
  idChip: string
}

/**
 * How a conversation is named (c-conversation-continue, page-05): its recorded title, or, where none is recorded (most
 * conversations on real data: the mapper sends null, and workers before 16.0.0 sent "Conversation 258113dd", read the
 * same way, G19), the tool's words "{tool} conversation"; and its id as a small chip (conversationIdChip), first eight
 * characters or, when another listed conversation starts with the same eight, "…" and its last eight. The plan leads a
 * row with the last thing the owner said in it where the data has that (G19); no worker records which prompt belongs to
 * which conversation yet, so the title leads. Every place that names a conversation takes its name from here (its row,
 * the picker, and the controls that act on it, conversationControlNames), so a screen reader hears the row's words.
 */
export function conversationNaming(
  conversation: Pick<Request['conversations'][number], 'tool' | 'title' | 'conversationSessionId'>,
  listed: readonly Pick<Request['conversations'][number], 'conversationSessionId'>[],
): ConversationNaming {
  const { conversationSessionId, title } = conversation
  const firstEight = conversationSessionId.slice(0, 8)
  const sharesItsStart = listed.some((other) => other.conversationSessionId !== conversationSessionId && other.conversationSessionId.slice(0, 8) === firstEight)
  return {
    recordedTitle: title === null || title === legacyUntitledConversationTitle(conversationSessionId) ? null : title,
    tool: conversation.tool,
    idChip: conversationIdChip(conversationSessionId, sharesItsStart),
  }
}

/**
 * The small monospace chip that tells a conversation from the others listed with it: the session id's first eight
 * characters, as the old title showed them, or "…" and its last eight when `anotherStartsTheSame` (Codex ids started
 * within a minute share their first eight; SESSION_ID_END says why the last eight tell them apart).
 */
export const conversationIdChip = (conversationSessionId: string, anotherStartsTheSame: boolean) =>
  anotherStartsTheSame ? `…${sessionIdEndOf(conversationSessionId)}` : conversationSessionId.slice(0, 8)

// ---- What a row shows

/** Words for the owner: `english` is the sentence and its i18n catalog key, and `values` fill its {placeholders}. */
export interface ContinuationWords { english: string; values: Record<string, string | number> }

/**
 * What the reply card shows (c-conversation-continue: one card per request answers one conversation at a time). Its one
 * writer is replyCardState, from the card's read of the conversation it answers and the card's own Send:
 *   reading → idle | cannot-continue | read-failure    the first read answers, or fails
 *   read-failure → reading's outcomes                  "Try again" reads it again, until something has been read
 *   idle → sending → turn-running → idle               Send with words; the worker runs the turn; the turn ends
 *   idle | turn-running → cannot-continue              a later read says it can no longer be continued from here
 * A read that fails after one answered leaves the card as that read left it, with the failure and "Try again" under it
 * (conversationReadFailureView), as a conversation's row does.
 */
export const REPLY_CARD_STATES = ['reading', 'idle', 'sending', 'turn-running', 'cannot-continue', 'read-failure'] as const
export type ReplyCardState = typeof REPLY_CARD_STATES[number]

/**
 * How each state is worded, in one table: an exchange's state (ConversationContinuationState) as its row shows it, and
 * the reply card's (ReplyCardState) as the line under its box. A new state of either fails the typecheck here until it
 * has words. 'read-failure' has no line of its own: the read's own words show there (why the read failed, whole).
 */
export const CONTINUATION_STATE_WORDS: Record<ConversationContinuationState | Exclude<ReplyCardState, 'read-failure'>, string> & Record<'read-failure', null> = {
  running: 'Working…',
  replied: 'Replied',
  failed: 'Did not finish',
  reading: 'Reading the conversation…',
  // Shown while the box is empty: why Send waits (G16: a dimmed primary says what it waits for).
  idle: 'Write a reply, then send it.',
  sending: 'Sending your reply…',
  'turn-running': 'You can send again when this turn ends.',
  // Also where the worker gave its own reason: that reason is its words, folded under Details beside these (G17, fix
  // round R1; ConversationContinuationView refusalText).
  'cannot-continue': 'This conversation can’t be continued from here.',
  'read-failure': null,
}

/**
 * The reply card's state (ReplyCardState), its one writer: the card's box for the conversation it answers calls it once
 * per render and draws what it returns (components/conversation-continue.tsx ConversationComposer). `conversationIsContinuable`:
 * the conversation can be offered at all (isContinuableConversation), and one that cannot is never read; `read`: the
 * last read that answered, if any; `readFailed`: the newest read failed; `sending`: the card's Send is on its way.
 */
export function replyCardState({ conversationIsContinuable, read, readFailed, sending }: {
  conversationIsContinuable: boolean
  read: Pick<ConversationContinuationRead, 'target' | 'exchanges'> | null
  readFailed: boolean
  sending: boolean
}): ReplyCardState {
  if (!conversationIsContinuable) return 'cannot-continue'
  if (read === null) return readFailed ? 'read-failure' : 'reading'
  if (!read.target.canContinue) return 'cannot-continue'
  if (sending) return 'sending'
  return read.exchanges.some((exchange) => exchange.state === 'running') ? 'turn-running' : 'idle'
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

/**
 * The exchange a row sent a Stop for, while its turn ends: its id and the moment it started, which together name one
 * exchange of one worker's life. The id alone does not: each worker counts its exchanges from 1, so after a worker restart
 * the first exchange sent has the id of the first exchange sent before it. That later one started after the new worker
 * did, so after every exchange the worker before it started (only a clock set back across the restart to that very
 * millisecond could give it the same start).
 */
export type ExchangeAStopWasSentFor = Pick<ConversationContinuation, 'exchangeId' | 'startedAtEpochMs'>

/** One exchange as its row shows it. */
export interface ConversationExchangeView {
  exchangeId: number
  /** When the worker started it: with exchangeId, which exchange of which worker's life it is (ExchangeAStopWasSentFor). */
  startedAtEpochMs: number
  /**
   * Whether the row sent a Stop for this exchange, so its Stop waits for the turn to end: a second Stop would change
   * nothing. Never for an exchange of another worker's life that has the same id.
   */
  stopWasSent: boolean
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
  /**
   * The worker's sentence when this conversation can't be continued from here, whole. The row and the card show no box,
   * the state's words ("This conversation can’t be continued from here."), and this sentence folded under Details: it
   * is the worker's English, never the visible text (G17, fix round R1).
   */
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
 * a failure or the folder. `exchangeAStopWasSentFor` is the exchange the row last sent a Stop for, if any.
 */
export function continuationView(
  target: ConversationContinuationTarget,
  exchanges: ConversationContinuation[],
  typedMessage: string,
  exchangeAStopWasSentFor: ExchangeAStopWasSentFor | null = null,
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
    exchanges: exchanges.map((exchange) => exchangeView(exchange, exchangeAStopWasSentFor)),
  }
}

function exchangeView(exchange: ConversationContinuation, exchangeAStopWasSentFor: ExchangeAStopWasSentFor | null): ConversationExchangeView {
  const replyText = exchange.state === 'replied' && exchange.replyText?.trim() ? exchange.replyText : null
  const deniedToolCallCount = exchange.deniedToolCallCount ?? 0
  const notices: ContinuationWords[] = []
  if (exchange.state === 'replied' && replyText === null) notices.push(NO_WRITTEN_REPLY)
  if (deniedToolCallCount > 0) notices.push(deniedToolCallWords(deniedToolCallCount))
  return {
    exchangeId: exchange.exchangeId,
    startedAtEpochMs: exchange.startedAtEpochMs,
    stopWasSent: exchangeAStopWasSentFor !== null && exchangeAStopWasSentFor.exchangeId === exchange.exchangeId
      && exchangeAStopWasSentFor.startedAtEpochMs === exchange.startedAtEpochMs,
    ownerMessage: exchange.ownerMessage,
    state: exchange.state,
    stateWords: CONTINUATION_STATE_WORDS[exchange.state],
    replyText,
    failureText: exchange.state === 'failed' && exchange.failureText ? exchange.failureText : null,
    notices,
  }
}

/**
 * The calls a conversation's card and row make, as their failures are told to people (G17, plan Phase 5 fix round M1):
 * one plain sentence per call, in the page's language, shown; why it failed (local-source.ts's sentence: the worker's
 * own words, the status it answered, or the browser's error) folded under Details, whole. A turn that did not finish is
 * not a call that failed: its exchange says so with its state's words, and what the CLI printed is its Details.
 */
export type ConversationCall = 'read' | 'send' | 'stop' | 'open-in-app'
export const CONVERSATION_CALL_FAILURE_WORDS: Record<ConversationCall, string> = {
  read: 'Could not read this conversation.',
  send: 'Your reply was not sent.',
  stop: 'Could not stop this turn.',
  'open-in-app': 'Could not open this conversation in its app.',
}

/** A failed read of the conversation, as its row shows it: why, and the button that reads it again. */
export interface ConversationReadFailureView {
  /** What shows: the plain sentence for a failed read (CONVERSATION_CALL_FAILURE_WORDS), the catalog's key. */
  sentence: string
  /** The worker's sentence, or why the worker could not be reached, as it is: folded under Details. */
  failureText: string
  /** The button's words: the drawer's own "Try again". */
  tryAgainLabel: string
  /** The button's words while the read it asked for is on its way. */
  tryingAgainLabel: string
  /** Whether the read "Try again" asked for is on its way, so the button shows tryingAgainLabel. */
  isTryingAgain: boolean
}

/**
 * What a row shows when its last read of the conversation failed: why, with "Try again" beside it, which reads it again.
 * The first read too, when nothing has been read yet. A later read that failed leaves the row as the last read that
 * answered left it, which may be out of date: the reply a notice told of stays unread, and Send stays as it was, until a
 * read answers. Nothing else reads again but the next notice, so without the button a row could stay that way. Null when
 * the last read answered.
 *
 * `readFailure` is why the newest read that answered failed, and `isTryingAgain` whether the read "Try again" asked for is
 * still on its way. While it is, the reason and the button stay, and the button says it is trying again, so the way out
 * stays on screen for as long as that read takes: when nothing has been read yet, they are all the row shows. The button
 * can still be pressed then, so a read that never answers does not leave the row without one: only the newest read is
 * shown. That read's answer replaces them: one that brought the conversation back shows it (null here), and one that
 * failed shows its own reason, with "Try again" again.
 */
export function conversationReadFailureView(readFailure: string | null, isTryingAgain: boolean): ConversationReadFailureView | null {
  return readFailure === null ? null : { sentence: CONVERSATION_CALL_FAILURE_WORDS.read, failureText: readFailure, tryAgainLabel: 'Try again', tryingAgainLabel: 'Trying again…', isTryingAgain }
}

// ---- What a row's controls are called, and where focus goes after Send or Stop

/**
 * The last eight characters of a session id, which tell apart conversations whose titles match. Why eight: they are 32
 * random bits, so two ids share them about once in four billion pairs. Both tools' ids end in random bits: a Claude Code
 * id is a random UUID (version 4), and a Codex id is a time-ordered one (version 7), whose first eight characters are the
 * top bits of the millisecond it started, the same for every id started in the same 65.5 seconds. The title shows those
 * first eight (to-work-model.ts). Checked on a real database: the last eight told every session id apart, while many
 * Codex ids shared their first eight.
 */
const SESSION_ID_END = /.{8}$/
const sessionIdEndOf = (conversationSessionId: string) => conversationSessionId.match(SESSION_ID_END)?.[0] ?? conversationSessionId

/** What a conversation's message box, Send, Stop and "Reply here" are called for a screen reader. */
export interface ConversationControlNames { messageBox: ContinuationWords; sendButton: ContinuationWords; stopButton: ContinuationWords; replyHere: ContinuationWords }

/**
 * What a conversation's message box, Send, Stop and "Reply here" are called for a screen reader (fix round L6, Q13). A
 * request can list several conversations, each with its own box, Send, Stop and row, so each name says which one it
 * acts on, the way its row names it: `conversationName` is conversationNaming's name in the page's language (the
 * recorded title, or "{tool} conversation") and its id chip, which tells it from every other listed conversation, so two
 * names never read alike. Each name starts with the words its control shows ("Your reply", "Send", "Stop", "Reply
 * here"), which stay as they are (WCAG 2.5.3, label in name).
 */
export function conversationControlNames(conversationName: string): ConversationControlNames {
  const values = { conversation: conversationName }
  return {
    messageBox: { english: 'Your reply to {conversation}', values },
    sendButton: { english: 'Send to {conversation}', values },
    stopButton: { english: 'Stop the turn in {conversation}', values },
    replyHere: { english: 'Reply here to {conversation}', values },
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

/** What a row offers beside Send, as two quiet buttons under the message box, and the folder line above the box. */
export interface ConversationAppActionsView {
  /**
   * "Open in {app}" and its button's name, when the worker says it can open the conversation in an app on this computer
   * (the target's opensInAppNamed) and this page can ask it to. `app`: that app's name, for the line the row shows once
   * it has opened there ("Opened in {app}.", fix round R1).
   */
  openInApp: { app: string; label: ContinuationWords; buttonName: ContinuationWords } | null
  copyResumeCommand: {
    /** What the button copies: fixed words and the session id (resumeCommandFor). The folder is never part of it. */
    command: string
    buttonName: ContinuationWords
    /** The button's name while it shows "Copied". */
    copiedButtonName: ContinuationWords
  }
  /**
   * Above the box, as the conversation line's second line, while the recorded folder exists: where a turn sent from here
   * runs, and so where to cd before the copied command. When the folder is gone, the notice in the same place says where
   * the turn runs instead.
   */
  runsInFolderNotice: ContinuationWords | null
}

/**
 * What a conversation row offers beside Send: "Open in {app}" when the worker says it can open the conversation in an app
 * on this computer (the target's opensInAppNamed: only a Claude Code conversation, and only on macOS) and the page can ask
 * it to, and "Copy resume command" wherever the row shows Send. Null where the row shows no Send, because its
 * conversation can't be continued from here. The buttons are named like Send and Stop (conversationControlNames): the
 * words each shows, then the conversation it acts on as its row names it (`conversationName`).
 */
export function conversationAppActions(
  conversation: { platform: ContinuablePlatform; conversationSessionId: string; conversationName: string },
  target: ConversationContinuationTarget,
  sourceCanOpenInApp: boolean,
): ConversationAppActionsView | null {
  const command = resumeCommandFor(conversation.platform, conversation.conversationSessionId)
  if (!target.canContinue || command === null) return null
  const named = { conversation: conversation.conversationName }
  const app = target.opensInAppNamed
  return {
    openInApp: app === null || !sourceCanOpenInApp ? null : {
      app,
      label: { english: 'Open in {app}', values: { app } },
      buttonName: { english: 'Open in {app}: {conversation}', values: { app, ...named } },
    },
    copyResumeCommand: {
      command,
      buttonName: { english: 'Copy resume command for {conversation}', values: named },
      copiedButtonName: { english: 'Copied the resume command for {conversation}', values: named },
    },
    runsInFolderNotice: target.recordedFolderIsGone ? null : { english: 'Runs in {folder}', values: { folder: target.runsInFolder } },
  }
}

/** A folder path as its row lays it out: everything up to and including the last separator, then the folder's own name. */
export interface FolderPathForDisplay { parentWithSeparator: string; folderName: string }

/**
 * A folder path in two parts, so a row can keep the folder's own name on screen when the path is wider than its line:
 * the name is the part that tells conversations apart (a worktree or project name), and the parent is the part that
 * gives way. The two parts joined are the path, character for character, so nothing is taken out of it. A path that
 * ends in a separator keeps it on its name ("/work/example/" is "/work/" and "example/"), and a path with no separator
 * before its name, such as "/", is all name.
 */
export function folderPathForDisplay(folder: string): FolderPathForDisplay {
  // The last separator before the path's last character: one that ends the path belongs to the name. lastIndexOf reads a
  // negative start as 0, so a path of one character is looked at apart.
  const nameStartsAt = folder.length < 2 ? 0 : Math.max(folder.lastIndexOf('/', folder.length - 2), folder.lastIndexOf('\\', folder.length - 2)) + 1
  return { parentWithSeparator: folder.slice(0, nameStartsAt), folderName: folder.slice(nameStartsAt) }
}

/**
 * A folder path cut at its folder boundaries, longest first, for a line too narrow for it (page-05: paths were cut in
 * the middle of a folder's name): the path whole, then with the folders after its root giving way to "…" one at a
 * time, down to the root, "…" and the folder's own name ("/Users/…/use-plan-build-auto"). The row shows the first that
 * fits its line, and the whole path on a press. Each keeps the path's own separator; a path that ends in one keeps it
 * on its name, as folderPathForDisplay does. A path with no folder between its root and its name has nothing to cut.
 */
export function folderPathsCutAtFolders(folder: string): string[] {
  const separator = folder.includes('/') || !folder.includes('\\') ? '/' : '\\'
  const trailingSeparator = folder.length > 1 && folder.endsWith(separator) ? separator : ''
  const parts = (trailingSeparator ? folder.slice(0, -1) : folder).split(separator)
  // parts[0] is the root ('' before a leading separator, "~", "C:"); the last part is the folder's own name.
  if (parts.length < 3) return [folder]
  const cut: string[] = [folder]
  for (let foldersGivenWay = 1; foldersGivenWay <= parts.length - 2; foldersGivenWay++) {
    cut.push([parts[0], '…', ...parts.slice(1 + foldersGivenWay)].join(separator) + trailingSeparator)
  }
  return cut
}

/** A sentence that names a folder, as its row lays it out: the words before the folder, the folder, the words after it. */
export interface SentenceAroundFolder { wordsBefore: string; folder: string; wordsAfter: string }

/**
 * A sentence with a {folder} in it, split where the folder goes, so the row can draw the folder as a path
 * (folderPathForDisplay) inside the sentence in any language: the folder comes last in English and first in Korean.
 * `sentenceInPageLanguage` is the catalog's sentence with its {folder} still in it. Null when the sentence has no
 * {folder}, or its words carry no folder: the row then shows the sentence as it is.
 */
export function sentenceAroundFolder(sentenceInPageLanguage: string, words: ContinuationWords): SentenceAroundFolder | null {
  const folder = words.values.folder
  const folderGoesAt = sentenceInPageLanguage.indexOf('{folder}')
  if (typeof folder !== 'string' || folderGoesAt === -1) return null
  return {
    wordsBefore: sentenceInPageLanguage.slice(0, folderGoesAt),
    folder,
    wordsAfter: sentenceInPageLanguage.slice(folderGoesAt + '{folder}'.length),
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
 * What the row says when the clipboard did not take the resume command, beside its plain sentence ("Could not copy the
 * command.", which the row words itself): the browser's reason, whole, for Details, since it is the browser's words and
 * never the visible text (G17, fix round R1), and the line over the command shown to copy by hand.
 */
export function resumeCommandCopyFailureWords(reason: string): { details: string; copyItFromHere: ContinuationWords } {
  return {
    details: reason,
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
