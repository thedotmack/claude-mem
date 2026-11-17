// Continue a conversation from My Work: the owner types, that same Claude Code or Codex conversation takes the message as
// one turn, and its reply shows here.
// - One reply card per request (ConversationReplyCard, c-conversation-continue and page-05): a visible "Your reply" box
//   that answers one of the request's conversations at a time, picked from a list when there is more than one, with
//   Send and the conversation's other two ways in (open it in its tool's own app, copy the command that resumes it) as
//   quiet text beside it. Send is the screen's one orange button when the reply is the screen's decision (SendEmphasis).
//   Any layout can mount it: the request drawer does, and so can a focus area's main card or a board row (PR #6054).
// - Each conversation keeps its own row (ConversationRow), as under the drawer's "Where this came from": its name and
//   id, Open, Copy, the exchanges sent from here with a running turn's Stop, and "Reply here", which points the card at
//   it. Nothing is typed on a row, so 37 conversations draw one box, not 37.
// - ConversationContinue is the card's box for one given conversation, for a list that mounts one under each row.
// What each shows is decided by continuationView, replyCardState and conversationAppActions
// (live/conversation-continuation.ts). The worker's record is the state: each open box or row reads it, and reads it
// again on every notice about its conversation, so nothing here is stored. How a turn is started, stopped or read again
// is the same wherever it is drawn: one press of Send starts at most one turn, and nothing queues or retries by itself.
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { CheckIcon, CircleSlashIcon, ExternalLinkIcon, FolderIcon, FolderXIcon, ReplyIcon, SquareIcon, TerminalIcon } from 'lucide-react'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { FailureDetails, StateMark } from '@/components/bits'
import { AgentMark } from '@/components/brand'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { FieldHelperText, Textarea } from '@/components/ui/textarea'
import { SEARCHABLE_CHOICES_AFTER, SearchablePicker } from '@/components/searchable-picker'
import type { AgentTool, Request } from '@/data'
import { displayTime } from '@/lib/display-time'
import { interpolate, t, useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  CONTINUATION_STATE_WORDS, CONVERSATION_CALL_FAILURE_WORDS, buttonLabelsKeepingTheirWidth, continuationEventConcernsConversation, continuationView,
  conversationAppActions, conversationControlNames, conversationIdChip, conversationKey, conversationNaming, conversationReadFailureView,
  defaultReplyConversation, focusAfterSendOrStop, folderPathsCutAtFolders, isContinuableConversation, replyCardState, resumeCommandCopyFailureWords,
  sentenceAroundFolder, type ButtonLabelInPlace, type ConversationAppActionsView, type ConversationCall, type ConversationExchangeView,
  type ConversationNaming, type ConversationReadFailureView, type ContinuationWords, type ExchangeAStopWasSentFor,
} from '@/live/conversation-continuation'
import { TIME_NOT_RECORDED, conversationToolWords } from '@/live/to-work-model'
import type { ConversationContinuationRead, ConversationContinuationSource } from '@/live/work-data-source'
import { Req } from '@/spec/req'
import { useStore } from '@/store'
import type { ContinuablePlatform } from '../../../../shared/conversation-continuation.ts'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Words from live/conversation-continuation.ts in the page's language: `english` is the catalog key. */
const inPageLanguage = (words: ContinuationWords) => interpolate(t(words.english), words.values)

/** A conversation's name as its row and the picker show it (conversationNaming), in the page's language. */
const namedInPageLanguage = (naming: ConversationNaming) => naming.recordedTitle ?? interpolate(t('{tool} conversation'), { tool: conversationToolWords(naming.tool, t) })

/**
 * A conversation as the names of its controls say it (conversationControlNames): its name as its row shows it, then its
 * id chip ("Claude Code conversation 258113dd"), so a screen reader hears the row's own words (fix round L6, Q13).
 */
const conversationNameInPageLanguage = (naming: ConversationNaming) => `${namedInPageLanguage(naming)} ${naming.idChip}`

/** The tools that have their own mark (AgentMark); any other platform's conversation shows the neutral one. */
const TOOL_OF_PLATFORM: Partial<Record<string, AgentTool>> = { claude: 'claude', codex: 'codex', gemini: 'gemini' }

/**
 * How Send looks, by what the screen asks of the owner (G1: one solid orange button per decision unit):
 * - 'primary': solid orange from the start, dimmed until there are words: the reply is the screen's decision (your move);
 * - 'once-words-are-typed': outlined until the box has words, then solid, so a screen with no decision of its own shows no
 *   orange, and a list of boxes (ConversationContinue, one per row) is not a column of orange;
 * - 'outlined': outlined whatever is typed: another button is the screen's decision (Mark checked).
 * A layout choice by the screen's state, not a state shown in words.
 */
export type SendEmphasis = 'primary' | 'once-words-are-typed' | 'outlined'

/**
 * A button's labels laid in one place, with only the shown one visible (buttonLabelsKeepingTheirWidth), so the button
 * keeps the width of its wider label while its label changes. The hidden one is out of the accessibility tree too.
 */
function LabelsInOnePlace({ labels }: { labels: ButtonLabelInPlace[] }) {
  return (
    <span className="inline-grid place-items-center">
      {labels.map((label, index) => (
        <span key={index} className={label.isShown ? 'col-start-1 row-start-1' : 'invisible col-start-1 row-start-1'}>{label.text}</span>
      ))}
    </span>
  )
}

/**
 * The keys that send from the message box, as the Send button shows them: Command and Enter on a Mac, Ctrl and Enter
 * elsewhere. Both always work; this only picks which to show.
 */
const SEND_KEYS_HINT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘↵' : 'Ctrl ↵'

/**
 * The quiet buttons beside Send and on a row (Open in its app, Copy resume command, Reply here): text, not outlined
 * (c-conversation-continue: "quiet text"). The Button's own rule makes them 44px on touch (plan rule 6).
 */
const QUIET_ACTION = 'text-muted-foreground'

/**
 * One quiet line saying a conversation can't be continued from here, in the page's words, with the worker's reason,
 * when it gave one, folded under Details in monospace: the worker's sentence is English, so it is never the visible text
 * (G17, fix round R1). `focusWhenShown`: the person pressed Reply (G2) or "Reply here" for a conversation that cannot
 * be continued, so the line that says so takes focus once, and the press is seen and heard to land somewhere;
 * `onFocused` is told once it has.
 */
function CannotContinueLine({ children, reason = null, focusWhenShown = false, onFocused }: { children: ReactNode; reason?: string | null; focusWhenShown?: boolean; onFocused?: () => void }) {
  const line = useRef<HTMLParagraphElement>(null)
  // The caller's latest callback, so a new one on each of its renders does not restart the wait for the next frame.
  const tellFocused = useRef(onFocused)
  useEffect(() => { tellFocused.current = onFocused })
  // After the drawer's own first focus, which Radix gives its panel once this row's effects have run: one frame later.
  useEffect(() => {
    if (!focusWhenShown) return
    const frame = requestAnimationFrame(() => { line.current?.focus(); tellFocused.current?.() })
    return () => cancelAnimationFrame(frame)
  }, [focusWhenShown])
  const sentence = (
    // Focusable from script only (never a Tab stop), and it stays so after the press is served, or focus would drop to the page.
    <p ref={line} tabIndex={-1} className="flex items-start gap-1.5 rounded-sm break-words text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      <CircleSlashIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0">{children}</span>
    </p>
  )
  if (!reason) return sentence
  return <div>{sentence}<FailureDetails cause={reason} /></div>
}

/**
 * A call that did not happen (G17, fix round M1): its plain sentence in the page's language, then why, as the worker or
 * the browser said it (local-source.ts's words, whole), folded under Details in monospace.
 */
function CallFailure({ call, cause }: { call: ConversationCall; cause: string }) {
  useI18n()
  return (
    <div role="alert" className="space-y-1 text-sm">
      <p className="font-medium break-words">{t(CONVERSATION_CALL_FAILURE_WORDS[call])}</p>
      <FailureDetails cause={cause} />
    </div>
  )
}

/**
 * The element whose width a path in a line of wrapping words must fit: the whole line (FolderLine marks it). Found in the
 * page when the path measures, since the line's own ref is attached only after the path's layout effect has run.
 */
const WHOLE_FOLDER_LINE = '[data-folder-line]'

/**
 * The longest of folderPathsCutAtFolders that fits the width of the path's own line (`line`, a flex-1 box), or with
 * `fitsTheWholeLine` of the whole line it sits in (WHOLE_FOLDER_LINE), measured in the path's own font and kept current
 * as that element resizes. The measured element takes its width from its layout, never from the path's text.
 * `wordsAgainstItsEnd` are measured with the path, since they share its line (FolderPath); the line they sit in has the
 * path's font (the folder line's monospace, at the same size).
 */
function useFolderPathThatFits(folder: string, measuring: boolean, fitsTheWholeLine: boolean, wordsAgainstItsEnd: string) {
  const line = useRef<HTMLSpanElement>(null)
  /**
   * The path shown, with the folder it was measured for (so a new folder shows whole until it is measured), and whether
   * it fits on one line. When even the shortest cut (the root, "…" and the folder's own name) is wider than the line,
   * that cut wraps rather than lose the end of the folder's name.
   */
  const [measured, setMeasured] = useState<{ folder: string; path: string; fitsOnOneLine: boolean } | null>(null)
  useLayoutEffect(() => {
    const element = line.current
    const space = fitsTheWholeLine ? element?.closest<HTMLElement>(WHOLE_FOLDER_LINE) ?? element : element
    if (!measuring || !element || !space) return
    const cut = folderPathsCutAtFolders(folder)
    // A canvas measures text without laying it out. Without one the path shows whole, cut at its end by CSS.
    const canvas = document.createElement('canvas').getContext('2d')
    if (!canvas) return
    const choose = () => {
      const style = getComputedStyle(element)
      canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const width = space.clientWidth
      const fitting = cut.find((path) => canvas.measureText(path + wordsAgainstItsEnd).width <= width)
      const next = { folder, path: fitting ?? cut[cut.length - 1], fitsOnOneLine: fitting !== undefined }
      // The same answer keeps the same state, so the wrap it may cause (a height change the observer sees) ends here.
      setMeasured((previous) => previous && previous.folder === next.folder && previous.path === next.path && previous.fitsOnOneLine === next.fitsOnOneLine ? previous : next)
    }
    choose()
    const observer = new ResizeObserver(choose)
    observer.observe(space)
    return () => observer.disconnect()
  }, [folder, measuring, fitsTheWholeLine, wordsAgainstItsEnd])
  const current = measured?.folder === folder ? measured : null
  return { line, pathThatFits: current?.path ?? folder, fitsOnOneLine: current?.fitsOnOneLine ?? true }
}

/**
 * A folder path on one line, cut at a folder boundary when the line is too narrow for it (page-05: paths were cut inside
 * a folder's name): the folders after its root give way to "…", and the folder's own name stays. The whole path is
 * always its name, for a screen reader and for hover, and a press shows it whole on as many lines as it needs. At least
 * 24px tall at the desktop size (WCAG 2.5.8; it was 16px) and 44px on touch, by the Button's own rule.
 * `fitsTheWholeLine`: the path is one piece in a line of words that wrap (a folder that is gone, V2), cut to fit that
 * whole line, so it moves to its own line rather than squeeze into what the words leave. `wordsAgainstItsEnd`, with it:
 * the sentence's words written right against the path's end, with no space before them ("." in English and French,
 * "에서" in Korean), drawn after it in the same piece and after its last line, so they never start a line alone (the full
 * stop sat alone on the last line at 390); the cut leaves them their room.
 */
function FolderPath({ folder, fitsTheWholeLine = false, wordsAgainstItsEnd = '' }: { folder: string; fitsTheWholeLine?: boolean; wordsAgainstItsEnd?: string }) {
  const [wholePathIsShown, setWholePathIsShown] = useState(false)
  const { line, pathThatFits, fitsOnOneLine } = useFolderPathThatFits(folder, !wholePathIsShown, fitsTheWholeLine, wordsAgainstItsEnd)
  const path = (
    // Named with the path as it is: read from its parts, a screen reader would put spaces where they meet.
    <Button variant="bare" type="button" title={folder} aria-label={folder} aria-expanded={wholePathIsShown}
      onClick={() => setWholePathIsShown((isShown) => !isShown)}
      className={cn('min-w-0 rounded-sm py-1 font-mono text-xs hover-enabled:text-foreground', !fitsTheWholeLine && 'flex-1')}>
      <span ref={line} className={cn('min-w-0 flex-1', wholePathIsShown || !fitsOnOneLine ? 'break-all' : 'truncate')}>{wholePathIsShown ? folder : pathThatFits}</span>
    </Button>
  )
  if (!fitsTheWholeLine) return path
  return (
    <span className="inline-flex max-w-full items-baseline-last align-middle">
      {path}<span className="shrink-0 whitespace-pre">{wordsAgainstItsEnd}</span>
    </span>
  )
}

/**
 * Where a reply runs, as the helper line under the box (c-conversation-continue: "the folder as helper text under the
 * box"), in monospace: the catalog's sentence, with its folder drawn as a path (FolderPath). A recorded folder that is
 * gone is one line with its own icon, saying where the turn will run instead, before anything is sent: its longer
 * sentence wraps as whole words, and its folder is one piece cut to fit the line, never squeezed beside the words (V2:
 * at 390 the path broke into a column one letter wide, and the words ran past the line). The words written right against
 * the folder's end, up to the first space (the full stop in English), are part of that piece.
 */
function FolderLine({ id, words, folderIsGone = false }: { id: string; words: ContinuationWords; folderIsGone?: boolean }) {
  const sentence = sentenceAroundFolder(t(words.english), words)
  if (folderIsGone) {
    const wordsAgainstTheFolder = sentence?.wordsAfter.match(/^\S*/)?.[0] ?? ''
    return (
      <FieldHelperText id={id} data-folder-gone className="min-w-0 font-mono [&>span]:min-w-0 [&>span]:flex-1">
        <span data-folder-line className="block">
          <FolderXIcon aria-hidden="true" className="mr-1.5 inline size-3.5 align-[-0.15em]" />
          {sentence
            ? <><span className="whitespace-pre-wrap">{sentence.wordsBefore}</span>
              <FolderPath folder={sentence.folder} fitsTheWholeLine wordsAgainstItsEnd={wordsAgainstTheFolder} />
              <span className="whitespace-pre-wrap">{sentence.wordsAfter.slice(wordsAgainstTheFolder.length)}</span></>
            : inPageLanguage(words)}
        </span>
      </FieldHelperText>
    )
  }
  return (
    // The sentence's words keep their own spaces (a language may put none between the folder and the word after it), and
    // the folder takes what is left of the line.
    <FieldHelperText id={id} className="min-w-0 items-center font-mono [&>span]:flex [&>span]:min-w-0 [&>span]:flex-1 [&>span]:items-center">
      <FolderIcon aria-hidden="true" className="mr-1.5 size-3.5 shrink-0" />
      {sentence
        ? <><span className="shrink-0 whitespace-pre">{sentence.wordsBefore}</span><FolderPath folder={sentence.folder} /><span className="shrink-0 whitespace-pre">{sentence.wordsAfter}</span></>
        : inPageLanguage(words)}
    </FieldHelperText>
  )
}

/**
 * Why the last read of the conversation failed, in plain words with the reason under Details (G17, fix round M1), and
 * "Try again" beside it, which the sentence describes for a screen reader. While the read it asked for is on its way,
 * the button says so in place of its label, and keeps its width.
 */
function ReadFailure({ view, onTryAgain }: { view: ConversationReadFailureView; onTryAgain: (pressedButton: HTMLButtonElement) => void }) {
  useI18n()
  const failureId = useId()
  return (
    <div className="flex flex-wrap items-start gap-2">
      <div role="alert" className="min-w-0 flex-1 basis-48 space-y-1 text-sm">
        <p id={failureId} className="font-medium break-words">{t(view.sentence)}</p>
        <FailureDetails cause={view.failureText} />
      </div>
      <Button variant="outline" size="sm" aria-describedby={failureId} onClick={(event) => onTryAgain(event.currentTarget)}>
        <LabelsInOnePlace labels={buttonLabelsKeepingTheirWidth(t(view.tryAgainLabel), t(view.tryingAgainLabel), view.isTryingAgain)} />
      </Button>
    </div>
  )
}

/** Which conversation a box or row reads: null for one this page cannot offer to continue, which is never read. */
type ReadConversation = { platform: ContinuablePlatform; conversationSessionId: string } | null

/**
 * The worker's record of one conversation: read when its box or row opens, then again on each notice about it and each
 * reopened live stream, so it never stays on a missed notice. Only the newest read is shown: an older answer that
 * arrives late is dropped. `readFailure` is why the newest read that answered failed; "Try again" leaves it on screen
 * until a read answers (conversationReadFailureView).
 */
function useConversationRead(source: ConversationContinuationSource, conversation: ReadConversation) {
  const platform = conversation?.platform ?? null
  const conversationSessionId = conversation?.conversationSessionId ?? null
  const [read, setRead] = useState<ConversationContinuationRead | null>(null)
  const [readFailure, setReadFailure] = useState<string | null>(null)
  /** "Try again" was pressed, and no read has answered since (conversationReadFailureView). */
  const [tryingAgain, setTryingAgain] = useState(false)
  /** Reads the conversation again. Null once the box or row is closed. */
  const readAgain = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (platform === null || conversationSessionId === null) return
    let rowIsOpen = true
    let newestRead = 0
    const readConversation = () => {
      const thisRead = ++newestRead
      source.loadConversationContinuation(platform, conversationSessionId).then(
        (answer) => { if (rowIsOpen && thisRead === newestRead) { setRead(answer); setReadFailure(null); setTryingAgain(false) } },
        (error: unknown) => { if (rowIsOpen && thisRead === newestRead) { setReadFailure(messageOf(error)); setTryingAgain(false) } },
      )
    }
    readAgain.current = readConversation
    readConversation()
    const stopHearing = source.subscribeToConversationContinuations((event) => {
      if (continuationEventConcernsConversation(event, { platform, conversationSessionId })) readConversation()
    })
    return () => { rowIsOpen = false; readAgain.current = null; stopHearing() }
  }, [source, platform, conversationSessionId])
  return {
    read,
    readFailed: readFailure !== null,
    readFailureView: conversationReadFailureView(readFailure, tryingAgain),
    readAgain: () => readAgain.current?.(),
    /** "Try again": the reason and the button stay, saying it is trying again, until a read answers. */
    tryAgain: () => { setTryingAgain(true); readAgain.current?.() },
  }
}

/**
 * The exchange a Stop was sent for, per conversation, shared by every place on the page that shows the conversation's
 * running turn (the reply card's running line and the conversation's row), so a Stop pressed in one waits in both: a
 * second Stop would change nothing (ExchangeAStopWasSentFor). One entry per conversation shown.
 */
const stopsSent = new Map<string, ExchangeAStopWasSentFor>()
const stopsSentListeners = new Set<() => void>()
const hearStopsSent = (listener: () => void) => { stopsSentListeners.add(listener); return () => { stopsSentListeners.delete(listener) } }

/** Stopping a conversation's running turn, and which exchange a Stop was already sent for. */
function useTurnStop(source: ConversationContinuationSource, conversation: ReadConversation) {
  const key = conversation === null ? null : conversationKey(conversation)
  const stopSentFor = useSyncExternalStore(hearStopsSent, () => (key === null ? null : stopsSent.get(key) ?? null))
  const recordStopSent = (exchange: ExchangeAStopWasSentFor | null) => {
    if (key === null) return
    if (exchange) stopsSent.set(key, exchange)
    else stopsSent.delete(key)
    for (const listener of stopsSentListeners) listener()
  }
  /**
   * Sends one Stop. The exchange stays running until the CLI has exited; the notice that it ended reads the conversation
   * again. Resolves with why it did not stop (the worker's or the browser's words), or null. A conversation that is
   * never read has no running turn to stop.
   */
  const stop = async (exchange: ExchangeAStopWasSentFor): Promise<string | null> => {
    if (conversation === null) return null
    recordStopSent({ exchangeId: exchange.exchangeId, startedAtEpochMs: exchange.startedAtEpochMs })
    try {
      await source.stopConversationContinuation(conversation.platform, conversation.conversationSessionId)
      return null
    } catch (error) {
      recordStopSent(null)
      return messageOf(error)
    }
  }
  return { stopSentFor, stop }
}

/**
 * The exchanges sent from My Work, read like a chat: what the owner sent on the right, what the conversation answered on
 * the left under its tool's name. A running turn's Stop sits on its line (c-conversation-continue: "Stop on the running
 * line"). `live`: this list is where the page shows the conversation's turns as they happen (the reply card), so a
 * running turn's line moves (Shimmer) and a screen reader hears each update here, once; elsewhere (a conversation's row
 * under the card) the same turn stays still, G11's static working ring and its words (fix round M2, plan rule 8). A turn
 * that did not finish says so in its state's words, with what the CLI printed folded under Details (M1).
 */
function ExchangeList({ exchanges, platform, toolName, live, stopIsShown, stopButtonName, onStop }: {
  exchanges: ConversationExchangeView[]
  platform: ContinuablePlatform
  toolName: string
  live: boolean
  stopIsShown: boolean
  stopButtonName: string
  onStop: (exchange: ConversationExchangeView, pressedButton: HTMLButtonElement) => void
}) {
  return (
    <div className="space-y-3 py-1" aria-live={live ? 'polite' : undefined}>
      {exchanges.map((exchange) => (
        <div key={exchange.exchangeId} data-exchange-state={exchange.state} className="space-y-2 text-sm">
          <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 whitespace-pre-wrap break-words text-secondary-foreground">{exchange.ownerMessage}</p>
          <div className="space-y-1.5">
            <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <AgentMark tool={platform} className="size-3.5" />
              <span className="font-medium text-foreground">{conversationToolWords(toolName, t)}</span>
              {exchange.state === 'running'
                ? live
                  ? <Shimmer as="span">{t(exchange.stateWords)}</Shimmer>
                  : <span className="inline-flex items-center gap-1.5"><StateMark state="working" />{t(exchange.stateWords)}</span>
                : <span className={exchange.state === 'failed' ? 'text-destructive' : undefined}>{t(exchange.stateWords)}</span>}
              {exchange.state === 'running' && stopIsShown && (
                <Button variant="outline" size="sm" className="ml-auto" aria-label={stopButtonName} disabled={exchange.stopWasSent}
                  onClick={(event) => onStop(exchange, event.currentTarget)}><SquareIcon aria-hidden="true" className="fill-current" />{t('Stop')}</Button>
              )}
            </div>
            {exchange.replyText !== null && <p className="whitespace-pre-wrap break-words">{exchange.replyText}</p>}
            {exchange.failureText !== null && <FailureDetails cause={exchange.failureText} />}
            {exchange.notices.map((notice) => <p key={notice.english} className="text-xs text-muted-foreground">{inPageLanguage(notice)}</p>)}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * A conversation's other two ways in, as quiet text buttons on one row: open it in its tool's own app (when the worker
 * says an app on this computer can) and copy the command that resumes it. `leading` and `trailing` share the row ("Reply
 * here" before them on a conversation's row; Send after them in the card). Under the row, in the page's words: that it
 * opened in the app, or why an open or a copy did not happen; what the CLI printed, the worker's words and the browser's
 * error are folded under Details, whole, in monospace (G17, fix round R1).
 */
function ConversationWaysIn({ source, platform, conversationSessionId, appActions, leading, trailing }: {
  source: ConversationContinuationSource
  platform: ContinuablePlatform
  conversationSessionId: string
  appActions: ConversationAppActionsView
  leading?: ReactNode
  trailing?: ReactNode
}) {
  useI18n()
  /** The worker is still opening this conversation in its tool's app. */
  const [openingInApp, setOpeningInApp] = useState(false)
  /** Why the last "Open in" did not open it, in the worker's words, with what the CLI printed: folded under Details. */
  const [openInAppFailure, setOpenInAppFailure] = useState<string | null>(null)
  /**
   * The last "Open in" opened the conversation: in which app, and what the CLI printed as it did, such as "Opening
   * session … in Claude Desktop" (null when it printed nothing). Null until an open has worked.
   */
  const [openedInApp, setOpenedInApp] = useState<{ app: string; printedText: string | null } | null>(null)
  /** "Copied" shows on the copy button from a copy until the next click anywhere else. No timer. */
  const [resumeCommandCopied, setResumeCommandCopied] = useState(false)
  /** Why the clipboard did not take the command. The command is then shown as text to select and copy by hand. */
  const [resumeCommandCopyFailure, setResumeCommandCopyFailure] = useState<string | null>(null)
  const copyButton = useRef<HTMLButtonElement>(null)

  // A click anywhere but on the copy button puts "Copy resume command" back. A click on it copies again.
  useEffect(() => {
    if (!resumeCommandCopied) return
    const clickedSomewhere = (event: MouseEvent) => {
      if (event.target instanceof Node && copyButton.current?.contains(event.target)) return
      setResumeCommandCopied(false)
    }
    document.addEventListener('click', clickedSomewhere, true)
    return () => document.removeEventListener('click', clickedSomewhere, true)
  }, [resumeCommandCopied])

  const openInApp = async (app: string) => {
    const openConversationInApp = source.openConversationInApp
    if (!openConversationInApp || openingInApp) return
    setOpeningInApp(true)
    setOpenInAppFailure(null)
    setOpenedInApp(null)
    try {
      const opened = await openConversationInApp(platform, conversationSessionId)
      setOpenedInApp({ app, printedText: opened.printedText })
    } catch (error) {
      setOpenInAppFailure(messageOf(error))
    } finally {
      setOpeningInApp(false)
    }
  }

  const copyResumeCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setResumeCommandCopyFailure(null)
      setResumeCommandCopied(true)
    } catch (error) {
      // Also a page with no clipboard at all: the command is shown instead, to copy by hand.
      setResumeCommandCopied(false)
      setResumeCommandCopyFailure(messageOf(error))
    }
  }
  const copyFailureWords = resumeCommandCopyFailure === null ? null : resumeCommandCopyFailureWords(resumeCommandCopyFailure)
  const appItOpensIn = appActions.openInApp

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
        {leading}
        {appItOpensIn && (
          // aria-disabled, not disabled, while it opens: a disabled button drops focus to the page, so the owner keeps their place.
          <Button variant="ghost" size="xs" className={QUIET_ACTION} aria-label={inPageLanguage(appItOpensIn.buttonName)} aria-disabled={openingInApp}
            onClick={() => void openInApp(appItOpensIn.app)}>
            <ExternalLinkIcon aria-hidden="true" />
            <LabelsInOnePlace labels={buttonLabelsKeepingTheirWidth(inPageLanguage(appItOpensIn.label), t('Opening…'), openingInApp)} />
          </Button>
        )}
        <Button ref={copyButton} variant="ghost" size="xs" className={QUIET_ACTION}
          aria-label={inPageLanguage(resumeCommandCopied ? appActions.copyResumeCommand.copiedButtonName : appActions.copyResumeCommand.buttonName)}
          onClick={() => void copyResumeCommand(appActions.copyResumeCommand.command)}>
          {resumeCommandCopied ? <CheckIcon aria-hidden="true" /> : <TerminalIcon aria-hidden="true" />}
          {resumeCommandCopied ? t('Copied') : t('Copy resume command')}
        </Button>
        {trailing && <div className="ml-auto">{trailing}</div>}
      </div>
      {openedInApp && (
        // What happened, in the page's words; what the CLI printed as it opened it is its own output, so it goes under
        // the same Details fold a failure's cause does (FailureDetails), whole.
        <div role="status" className="space-y-1 text-xs text-muted-foreground">
          <p className="break-words">{interpolate(t('Opened in {app}.'), { app: openedInApp.app })}</p>
          <FailureDetails cause={openedInApp.printedText} />
        </div>
      )}
      {openInAppFailure && <CallFailure call="open-in-app" cause={openInAppFailure} />}
      {copyFailureWords && (
        <div className="space-y-1">
          <div role="alert" className="space-y-1 break-words text-xs text-muted-foreground">
            <p>{t('Could not copy the command.')}</p>
            <FailureDetails cause={copyFailureWords.details} />
            <p>{inPageLanguage(copyFailureWords.copyItFromHere)}</p>
          </div>
          <p className="select-all break-words font-mono text-xs">{appActions.copyResumeCommand.command}</p>
        </div>
      )}
    </div>
  )
}

/**
 * While the first read of the conversation is on its way (ReplyCardState 'reading'): the box's shape, so the card does
 * not jump when the read arrives (D b18 M 373), and the words, said once.
 */
function ReadingTheConversation() {
  useI18n()
  return (
    <div aria-busy="true" className="space-y-1.5">
      <p aria-hidden="true" className="text-sm leading-none font-medium text-muted-foreground">{t('Your reply')}</p>
      <Skeleton className="h-20 w-full rounded-lg" />
      <p role="status" className="text-xs text-muted-foreground">{t(CONTINUATION_STATE_WORDS.reading)}</p>
    </div>
  )
}

/**
 * The box for one conversation, drawn from the state replyCardState gives it (its one writer, called once per render):
 * the box's shape while it is first read; why the read failed, with Try again; one line when it cannot be continued from
 * here (a conversation this page cannot offer is never read); otherwise the exchanges sent from here (`exchangesShown`:
 * all of them, or the latest, live, with the earlier ones counted and folded, L5), a visible "Your reply" label, the box
 * at the Textarea's own edge and height, named for the conversation it answers (Q13), where the reply runs as the line
 * under it, then Open and Copy as quiet text and Send, which looks as `sendEmphasis` says (G1). When it cannot send it
 * stays focusable and dimmed (aria-disabled, G16), and the line under it says what it waits for: words in the box, or the
 * running turn's end, while the box stays, dimmed. `typedMessage` belongs to the caller, so words typed stay when the card
 * points at another conversation. `onSendingChange` is told when a Send starts and when its answer comes.
 */
function ConversationComposer({
  source, conversation, naming, exchangesShown, typedMessage, onTypedMessageChange, focusWhenShown, onFocused, sendEmphasis, onSendingChange,
}: {
  source: ConversationContinuationSource
  conversation: Pick<Request['conversations'][number], 'platform' | 'conversationSessionId' | 'tool'>
  /** How its row names it (conversationNaming): the box, Send, Stop and the buttons beside Send are named with it. */
  naming: ConversationNaming
  exchangesShown: 'all' | 'latest'
  typedMessage: string
  onTypedMessageChange: (message: string) => void
  /** Reply (G2) or "Reply here": the first read decides where focus goes, once per ask; `onFocused` is told once it has. */
  focusWhenShown: boolean
  onFocused?: () => void
  sendEmphasis: SendEmphasis
  onSendingChange?: (sending: boolean) => void
}) {
  useI18n()
  const continuable = isContinuableConversation(conversation) ? conversation : null
  const conversationName = conversationNameInPageLanguage(naming)
  const names = conversationControlNames(conversationName)
  const { read, readFailed, readFailureView, readAgain, tryAgain } = useConversationRead(source, continuable)
  const { stopSentFor, stop } = useTurnStop(source, continuable)
  const [sending, setSending] = useState(false)
  /** Why the last Send or Stop did not happen: which call, and the worker's or the browser's words for Details (M1). */
  const [actionFailure, setActionFailure] = useState<{ call: ConversationCall; cause: string } | null>(null)
  /** Where focus goes after Send or Stop (focusAfterSendOrStop): the message box, or this whole box when there is none. */
  const messageBox = useRef<HTMLTextAreaElement>(null)
  const conversationBox = useRef<HTMLDivElement>(null)
  const boxId = useId()
  /** The folder line (or the folder-gone notice) and the line saying what Send waits for, tied to the box for a screen reader. */
  const folderLineId = useId()
  const stateLineId = useId()

  // The first read decides where focus goes, once per ask (fix round Q12: a caller may never say it was served, as
  // page-03's card may not), so a later read leaves focus where the owner put it: the message box when the conversation
  // can be continued, otherwise this box, which then holds the worker's reason it cannot. A new ask (the caller turning
  // `focusWhenShown` off and on again) is served again.
  const focusServed = useRef(false)
  useEffect(() => {
    if (!focusWhenShown) { focusServed.current = false; return }
    if (focusServed.current || !read) return
    focusServed.current = true
    ;(messageBox.current ?? conversationBox.current)?.focus()
    onFocused?.()
  }, [focusWhenShown, read, onFocused])

  const state = replyCardState({ conversationIsContinuable: continuable !== null, read, readFailed, sending })
  if (state === 'reading') return <div data-reply-state={state}><ReadingTheConversation /></div>
  if (state === 'read-failure') return readFailureView && <div data-reply-state={state}><ReadFailure view={readFailureView} onTryAgain={() => tryAgain()} /></div>
  // 'cannot-continue' for a conversation this page cannot offer at all: nothing was read, so the line stands alone.
  if (read === null || continuable === null) {
    return <div data-reply-state={state}><CannotContinueLine focusWhenShown={focusWhenShown} onFocused={onFocused}>{t(CONTINUATION_STATE_WORDS['cannot-continue'])}</CannotContinueLine></div>
  }
  const view = continuationView(read.target, read.exchanges, typedMessage, stopSentFor)
  const appActions = conversationAppActions({ platform: continuable.platform, conversationSessionId: continuable.conversationSessionId, conversationName },
    read.target, source.openConversationInApp !== undefined)
  const earlierExchanges = exchangesShown === 'all' ? [] : view.exchanges.slice(0, -1)
  const shownExchanges = exchangesShown === 'all' ? view.exchanges : view.exchanges.slice(-1)
  const turnIsRunning = state === 'turn-running'
  const cannotSend = !view.sendIsEnabled || sending
  const sendIsSolid = sendEmphasis === 'primary' || (sendEmphasis === 'once-words-are-typed' && (view.sendIsEnabled || sending))
  // What Send waits for (G16), or what it is doing: only while the box is empty, sending, or a turn runs.
  const stateLine = state === 'idle' ? (typedMessage.trim() === '' ? CONTINUATION_STATE_WORDS.idle : null)
    : state === 'sending' || state === 'turn-running' ? CONTINUATION_STATE_WORDS[state] : null
  const folderWords = view.folderGoneNotice ?? appActions?.runsInFolderNotice ?? null

  /** The pressed button is disabled next, or goes away, so the owner's place moves into this box first. */
  const keepFocusInConversation = (pressedButton: HTMLButtonElement) => {
    const focusTarget = focusAfterSendOrStop(document.activeElement === pressedButton, view)
    if (focusTarget === 'message-box') messageBox.current?.focus()
    if (focusTarget === 'conversation-box') conversationBox.current?.focus()
  }

  /**
   * Reads the conversation again after a failed read. A read that answers takes the button away, so focus moves into
   * this box first, as after Send.
   */
  const tryReadingAgain = (pressedButton: HTMLButtonElement) => {
    keepFocusInConversation(pressedButton)
    tryAgain()
  }

  /** `pressedButton` is Send when it was pressed. Cmd/Ctrl+Enter sends from the box, which keeps focus. */
  const send = async (pressedButton?: HTMLButtonElement) => {
    if (!view.sendIsEnabled || sending) return
    if (pressedButton) keepFocusInConversation(pressedButton)
    setSending(true)
    onSendingChange?.(true)
    setActionFailure(null)
    try {
      await source.continueConversation(continuable.platform, continuable.conversationSessionId, typedMessage)
      onTypedMessageChange('')
      // The list shown is always the worker's: read it now rather than wait for the notice.
      readAgain()
    } catch (error) {
      // What was typed stays in the box, so it can be sent again.
      setActionFailure({ call: 'send', cause: messageOf(error) })
    } finally {
      setSending(false)
      onSendingChange?.(false)
    }
  }

  const stopTurn = async (exchange: ConversationExchangeView, pressedButton: HTMLButtonElement) => {
    keepFocusInConversation(pressedButton)
    setActionFailure(null)
    const failure = await stop(exchange)
    if (failure) setActionFailure({ call: 'stop', cause: failure })
  }

  const sendButton = (
    <Button variant={sendIsSolid ? 'default' : 'outline'} size="sm" aria-label={inPageLanguage(names.sendButton)} aria-keyshortcuts="Meta+Enter Control+Enter"
      aria-disabled={cannotSend || undefined} onClick={(event) => void send(event.currentTarget)}>
      <LabelsInOnePlace labels={buttonLabelsKeepingTheirWidth(t('Send'), t('Sending…'), sending)} />
      {/* The keys that send from the box, shown where a keyboard is likely. Enter alone starts a new line: a Send starts a real turn. */}
      <kbd aria-hidden="true" className="hidden font-sans text-[0.7rem] opacity-75 md:inline">{SEND_KEYS_HINT}</kbd>
    </Button>
  )
  const exchangeList = (exchanges: ConversationExchangeView[], live: boolean) => (
    <ExchangeList exchanges={exchanges} platform={continuable.platform} toolName={conversation.tool} live={live} stopIsShown={view.stopIsShown}
      stopButtonName={inPageLanguage(names.stopButton)} onStop={(exchange, pressedButton) => void stopTurn(exchange, pressedButton)} />
  )

  return (
    // Focusable from script only when there is no message box, so a pressed Stop can leave focus here.
    <div ref={conversationBox} tabIndex={view.composerIsShown ? undefined : -1} data-reply-state={state}
      className="space-y-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      {/* The card shows the latest exchange; how many were sent before it is said, and they show on request (L5). */}
      {earlierExchanges.length > 0 && (
        <Collapsible>
          <CollapsibleFoldTrigger>{interpolate(earlierExchanges.length === 1 ? t('{count} earlier exchange') : t('{count} earlier exchanges'), { count: earlierExchanges.length })}</CollapsibleFoldTrigger>
          <CollapsibleContent className="pt-2">{exchangeList(earlierExchanges, false)}</CollapsibleContent>
        </Collapsible>
      )}
      {shownExchanges.length > 0 && exchangeList(shownExchanges, true)}
      {view.refusalText !== null && <CannotContinueLine reason={view.refusalText}>{t(CONTINUATION_STATE_WORDS['cannot-continue'])}</CannotContinueLine>}
      {view.composerIsShown && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={boxId} className={cn(turnIsRunning && 'text-muted-foreground')}>{t('Your reply')}</Label>
            <Textarea
              id={boxId}
              ref={messageBox}
              // The visible label is "Your reply"; the name says which conversation it answers, so several boxes on one
              // page can be told apart (Q13), and it starts with the label's words (WCAG 2.5.3).
              aria-label={inPageLanguage(names.messageBox)}
              aria-describedby={[folderWords ? folderLineId : null, stateLine ? stateLineId : null].filter(Boolean).join(' ') || undefined}
              placeholder={interpolate(t('Continue this {tool} conversation'), { tool: conversationToolWords(conversation.tool, t) })}
              value={typedMessage}
              // The Textarea's own edge and height (D b21 M 441): about three lines empty, growing with what is typed
              // (field-sizing-content). A browser without field-sizing shows three rows.
              rows={3}
              className={cn('resize-none', turnIsRunning && 'opacity-60')}
              // Read-only while Send is in flight, since a successful Send clears the box, which would lose words typed
              // meanwhile; and while a turn runs, dimmed, because Send waits for that turn to end.
              readOnly={sending || turnIsRunning}
              onChange={(event) => onTypedMessageChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            {folderWords && <FolderLine id={folderLineId} words={folderWords} folderIsGone={view.folderGoneNotice !== null} />}
          </div>
          {appActions
            ? <ConversationWaysIn source={source} platform={continuable.platform} conversationSessionId={continuable.conversationSessionId} appActions={appActions} trailing={sendButton} />
            : <div className="flex justify-end">{sendButton}</div>}
          {stateLine && <p id={stateLineId} role="status" className="text-sm text-muted-foreground">{t(stateLine)}</p>}
        </>
      )}
      {actionFailure && <CallFailure call={actionFailure.call} cause={actionFailure.cause} />}
      {readFailureView && <ReadFailure view={readFailureView} onTryAgain={tryReadingAgain} />}
    </div>
  )
}

/** One conversation's box: to continue it, or one line saying why it can't be continued from here. */
export function ConversationContinue({ platform, conversationSessionId, toolName, conversationTitle, anotherConversationHasTheSameTitle = false, focusMessageBoxWhenShown = false }: {
  /** The platform its conversation key records, such as "claude" or "codex". */
  platform: string
  conversationSessionId: string
  /** The tool's name as its line shows it, such as "Claude Code". */
  toolName: string
  /**
   * The conversation's recorded title, or null when none is recorded (as the mapper sends it, fix round R2): its box,
   * Send and Stop name it for a screen reader as its line does, by the title or "{tool} conversation" (conversationNaming).
   */
  conversationTitle: string | null
  /**
   * Another conversation listed beside this one shows the same title. Codex session ids are time-ordered, so
   * conversations started within a minute share their first characters, and the title made from them. The id chip in
   * the names of its box, Send and Stop is then the last eight characters of this session id, so the rows can be told
   * apart (conversationIdChip).
   */
  anotherConversationHasTheSameTitle?: boolean
  /**
   * The person pressed Reply (G2): the message box takes focus the first time the conversation is read. Where it cannot
   * be continued from here, the line saying why takes focus instead, as the drawer shows it.
   */
  focusMessageBoxWhenShown?: boolean
}) {
  useI18n()
  const source = useStore((state) => state.conversationContinuationSource())
  const [typedMessage, setTypedMessage] = useState('')
  const [focusIsAsked, setFocusIsAsked] = useState(focusMessageBoxWhenShown)
  // Only the page this computer's worker serves can run a CLI here; sample data and a cloud-served page add nothing.
  if (!source) return null
  // No list beside it to compare ids with: the caller says whether another row reads the same.
  const naming: ConversationNaming = {
    ...conversationNaming({ tool: toolName, title: conversationTitle, conversationSessionId }, []),
    idChip: conversationIdChip(conversationSessionId, anotherConversationHasTheSameTitle),
  }
  return (
    <Req ids={['R2.8']}>
      {/* One box under each row: Send stays outlined until it has words (G1), as before 16.0.0 (fix round L1). */}
      <ConversationComposer source={source} conversation={{ platform, conversationSessionId, tool: toolName }} naming={naming} exchangesShown="all"
        typedMessage={typedMessage} onTypedMessageChange={setTypedMessage} focusWhenShown={focusIsAsked} onFocused={() => setFocusIsAsked(false)}
        sendEmphasis="once-words-are-typed" />
    </Req>
  )
}

/**
 * The trigger's widest, from sm up: 18rem (306px at the 17px desktop root), so "Reply to", the trigger and "37 of 37"
 * stay on one line in the drawer's 612px panel in every language My Work speaks (fix round R4, measured at 1440 with
 * a long name, tests/ui/my-work/request-drawer.browser.test.ts): the row has 524px, and the label, the count and their
 * two gaps take 144px in English, 197 in Chinese, 184 in Korean, 215 in Turkish and 174 in French, so Turkish leaves the
 * trigger 309px. 20rem (340px) put the count on a second line in Chinese and Turkish. 37 is the most conversations one
 * request has on the owner's data (plan Phase 5 checklist), and any two-digit count is as wide in the mono face. Below
 * sm the trigger may take the row's whole width, on its own line.
 */
const PICKER_TRIGGER_WIDTH = 'max-w-full sm:max-w-72'

/**
 * Which conversation the reply card answers, when the request has more than one (c-conversation-continue, page-05): a
 * visible "Reply to" label, the list, and where the chosen one sits ("3 of 37"). Each choice is named as its row is
 * (conversationNaming). A short list is a Select; past SEARCHABLE_CHOICES_AFTER it is searchable (G15). It waits while
 * a reply is sending, so the reply goes where it was written. A name too long for the trigger's line is cut there, with
 * the whole name as its hover text, in what a screen reader hears, and whole in the list, where names wrap (L5).
 */
function ConversationPicker({ id, conversations, chosen, onChoose, cannotChoose }: {
  id: string
  conversations: Request['conversations']
  chosen: Request['conversations'][number]
  onChoose: (key: string) => void
  cannotChoose: boolean
}) {
  useI18n()
  const choices = conversations.map((conversation) => {
    const naming = conversationNaming(conversation, conversations)
    return { value: conversationKey(conversation), name: namedInPageLanguage(naming), idChip: naming.idChip }
  })
  const position = conversations.indexOf(chosen) + 1
  const chosenChoice = choices[position - 1]
  const wholeName = `${chosenChoice.name} ${chosenChoice.idChip}`
  /** A choice's words: cut on the trigger's one line, wrapping whole in the list. */
  const choiceWords = (choice: typeof chosenChoice, onOneLine: boolean) => (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={cn('min-w-0', onOneLine ? 'truncate' : 'break-words')}>{choice.name}</span>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{choice.idChip}</span>
    </span>
  )
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <Label htmlFor={id}>{t('Reply to')}</Label>
      {conversations.length > SEARCHABLE_CHOICES_AFTER ? (
        <SearchablePicker id={id} trigger={choiceWords(chosenChoice, true)} triggerTitle={wholeName}
          groups={[{ choices: choices.map((choice) => ({ value: choice.value, label: choiceWords(choice, false), searchWords: [choice.name, choice.idChip] })) }]}
          chosenValue={chosenChoice.value} onChoose={onChoose} searchPlaceholder={t('Find a conversation')} nothingFound={t('No conversation matches.')}
          countLine={interpolate(t('{count} conversations · type to narrow'), { count: conversations.length })} cannotChoose={cannotChoose}
          className={PICKER_TRIGGER_WIDTH} />
      ) : (
        <Select value={chosenChoice.value} onValueChange={onChoose} disabled={cannotChoose}>
          <SelectTrigger id={id} size="sm" title={wholeName} className={cn('min-w-0', PICKER_TRIGGER_WIDTH)}><SelectValue>{choiceWords(chosenChoice, true)}</SelectValue></SelectTrigger>
          <SelectContent>
            {choices.map((choice) => <SelectItem key={choice.value} value={choice.value}>{choiceWords(choice, false)}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      <span className="mono-number text-xs text-muted-foreground">{interpolate(t('{position} of {count}'), { position, count: conversations.length })}</span>
    </div>
  )
}

/**
 * The request's one reply card (c-conversation-continue, page-05, decision G2): a picker when it has more than one
 * conversation, then the box for the chosen one (ConversationComposer). Nothing on a page that cannot continue a
 * conversation (sample data, the cloud page), or with no conversation recorded. `chosenConversation` and
 * `onChooseConversation` let the page point it elsewhere ("Reply here" on a row); left out, the card picks its own,
 * starting from defaultReplyConversation. `focusBox`: put focus in the box once it shows (Reply, "Reply here"); the box
 * does it once per ask, and `onBoxFocused` is told once it has. `sendEmphasis`: how Send looks (SendEmphasis, G1).
 * `onSendingChange`: told when a Send starts and when its answer comes, so the page can hold "Reply here" meanwhile.
 * While a Send is on its way the card stays on its conversation, even when the list changes under it (a refresh that
 * reorders it moves the default): the Send's answer, and its failure, belong to the box that sent it (fix round L2).
 */
export function ConversationReplyCard({ conversations, chosenConversation, onChooseConversation, focusBox = false, onBoxFocused, sendEmphasis = 'primary', onSendingChange }: {
  conversations: Request['conversations']
  chosenConversation?: string | null
  onChooseConversation?: (key: string) => void
  focusBox?: boolean
  onBoxFocused?: () => void
  sendEmphasis?: SendEmphasis
  onSendingChange?: (sending: boolean) => void
}) {
  useI18n()
  const source = useStore((state) => state.conversationContinuationSource())
  const [ownChoice, setOwnChoice] = useState<string | null>(null)
  const [typedMessage, setTypedMessage] = useState('')
  const [sending, setSending] = useState(false)
  const pickerId = useId()
  const fallback = defaultReplyConversation(conversations)
  if (!source || !fallback) return null
  const chosenKey = chosenConversation ?? ownChoice
  const chosen = conversations.find((conversation) => conversationKey(conversation) === chosenKey) ?? fallback
  const choose = (key: string) => (onChooseConversation ? onChooseConversation(key) : setOwnChoice(key))
  const sendingChanged = (nowSending: boolean) => {
    setSending(nowSending)
    onSendingChange?.(nowSending)
    if (nowSending && chosenKey === null) choose(conversationKey(chosen))
  }
  return (
    <Req ids={['R2.8']}>
      <div data-slot="reply-card" className="space-y-3">
        {conversations.length > 1 && <ConversationPicker id={pickerId} conversations={conversations} chosen={chosen} onChoose={choose} cannotChoose={sending} />}
        <ConversationComposer key={conversationKey(chosen)} source={source} conversation={chosen} naming={conversationNaming(chosen, conversations)}
          exchangesShown="latest" typedMessage={typedMessage} onTypedMessageChange={setTypedMessage} focusWhenShown={focusBox} onFocused={onBoxFocused}
          sendEmphasis={sendEmphasis} onSendingChange={sendingChanged} />
      </div>
    </Req>
  )
}

/**
 * A conversation's own controls on its row: "Reply here", Open and Copy, then the exchanges sent from here with a
 * running turn's Stop, still (the reply card is where a running turn moves and is announced, M2), and why it can't be
 * continued or could not be read. Nothing is typed here. `replyHereWaits`: a Send is on its way from the card, so
 * "Reply here" waits (aria-disabled, G16) and the card stays on the conversation the words went to (L2, Q4).
 */
function ConversationTurns({ source, platform, conversationSessionId, toolName, naming, replyHereWaits, onReplyHere }: {
  source: ConversationContinuationSource
  platform: ContinuablePlatform
  conversationSessionId: string
  toolName: string
  naming: ConversationNaming
  replyHereWaits: boolean
  onReplyHere?: () => void
}) {
  useI18n()
  const conversationName = conversationNameInPageLanguage(naming)
  const names = conversationControlNames(conversationName)
  const { read, readFailureView, tryAgain } = useConversationRead(source, { platform, conversationSessionId })
  const { stopSentFor, stop } = useTurnStop(source, { platform, conversationSessionId })
  /** Why the last Stop did not happen, in the worker's or the browser's words, for Details (M1). */
  const [actionFailure, setActionFailure] = useState<string | null>(null)
  const turnsBox = useRef<HTMLDivElement>(null)
  if (!read) return readFailureView ? <ReadFailure view={readFailureView} onTryAgain={() => tryAgain()} /> : null
  const view = continuationView(read.target, read.exchanges, '', stopSentFor)
  const appActions = conversationAppActions({ platform, conversationSessionId, conversationName }, read.target, source.openConversationInApp !== undefined)
  const stopTurn = async (exchange: ConversationExchangeView, pressedButton: HTMLButtonElement) => {
    // The pressed Stop is disabled next. A row has no message box, so the owner's place moves to the row itself.
    if (focusAfterSendOrStop(document.activeElement === pressedButton, { composerIsShown: false }) === 'conversation-box') turnsBox.current?.focus()
    setActionFailure(null)
    const failure = await stop(exchange)
    if (failure) setActionFailure(failure)
  }
  return (
    <div ref={turnsBox} tabIndex={-1} className="space-y-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      {appActions && (
        <ConversationWaysIn source={source} platform={platform} conversationSessionId={conversationSessionId} appActions={appActions}
          leading={onReplyHere && (
            <Button variant="ghost" size="xs" className={QUIET_ACTION} aria-label={inPageLanguage(names.replyHere)} aria-disabled={replyHereWaits || undefined} onClick={onReplyHere}>
              <ReplyIcon aria-hidden="true" />{t('Reply here')}
            </Button>
          )} />
      )}
      {view.exchanges.length > 0 && (
        <ExchangeList exchanges={view.exchanges} platform={platform} toolName={toolName} live={false} stopIsShown={view.stopIsShown}
          stopButtonName={inPageLanguage(names.stopButton)} onStop={(exchange, pressedButton) => void stopTurn(exchange, pressedButton)} />
      )}
      {view.refusalText !== null && <CannotContinueLine reason={view.refusalText}>{t(CONTINUATION_STATE_WORDS['cannot-continue'])}</CannotContinueLine>}
      {actionFailure && <CallFailure call="stop" cause={actionFailure} />}
      {readFailureView && <ReadFailure view={readFailureView} onTryAgain={() => tryAgain()} />}
    </div>
  )
}

/**
 * One conversation as its row under "Where this came from" shows it (c-conversation-continue, page-05): its name and its
 * id as a small monospace chip (conversationNaming), with its time where one is recorded; then, on the page this
 * computer's worker serves, its own controls (ConversationTurns). `onReplyHere`: points the request's reply card at this
 * conversation and puts focus in its box; left out where the page has no reply card. `replyHereWaits`: a Send from the
 * card is on its way, so "Reply here" waits until it is answered.
 */
export function ConversationRow({ conversation, conversations, onReplyHere, replyHereWaits = false }: {
  conversation: Request['conversations'][number]
  /** Every conversation listed beside it, so its chip tells it from them. */
  conversations: Request['conversations']
  onReplyHere?: () => void
  replyHereWaits?: boolean
}) {
  useI18n()
  const source = useStore((state) => state.conversationContinuationSource())
  const naming = conversationNaming(conversation, conversations)
  const name = namedInPageLanguage(naming)
  const tool = TOOL_OF_PLATFORM[conversation.platform]
  return (
    <div data-slot="conversation-row" className="space-y-2">
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {tool && <AgentMark tool={tool} className="size-3.5" />}
        <span className="min-w-0 font-medium break-words">{name}</span>
        <Badge variant="outline" className="font-mono font-normal">{naming.idChip}</Badge>
        {conversation.at !== TIME_NOT_RECORDED && <span className="text-xs text-muted-foreground tabular">{displayTime(conversation.at)}</span>}
      </p>
      {source && (isContinuableConversation(conversation)
        ? <ConversationTurns source={source} platform={conversation.platform} conversationSessionId={conversation.conversationSessionId} toolName={conversation.tool}
            naming={naming} replyHereWaits={replyHereWaits} onReplyHere={onReplyHere} />
        : <CannotContinueLine>{t(CONTINUATION_STATE_WORDS['cannot-continue'])}</CannotContinueLine>)}
    </div>
  )
}
