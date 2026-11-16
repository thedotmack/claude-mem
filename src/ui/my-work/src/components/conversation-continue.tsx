// Continue a conversation where it is listed: the owner types under a Claude Code or Codex conversation, that same
// conversation takes the message as one turn, and its reply shows here. One self-contained, layout-free block under a
// conversation's line, so any list of conversations can mount it (the request drawer's "Where this came from" does).
// Beside Send, the conversation can be opened in its tool's own app, or the command that resumes it copied.
// How it is laid out, top to bottom: where a turn runs (the folder, which is what tells one conversation from the next on
// real data, where titles and times are mostly not recorded); the exchanges sent from here, as a chat; one box that holds
// the message and Send; and the two other ways in, quiet, under it.
// What it shows is decided by continuationView and conversationAppActions (live/conversation-continuation.ts). The
// worker's record is the state: each open row reads it, and reads it again on every notice about its conversation, so
// nothing here is stored.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CheckIcon, CircleSlashIcon, ExternalLinkIcon, FolderIcon, FolderXIcon, SquareIcon, TerminalIcon } from 'lucide-react'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { AgentMark } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { interpolate, t, useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  buttonLabelsKeepingTheirWidth, continuationEventConcernsConversation, continuationView, conversationAppActions, conversationControlNames,
  conversationReadFailureView, focusAfterSendOrStop, folderPathForDisplay, isContinuableConversation, resumeCommandCopyFailureWords,
  sentenceAroundFolder, type ButtonLabelInPlace, type ContinuationWords, type ConversationReadFailureView, type ExchangeAStopWasSentFor,
} from '@/live/conversation-continuation'
import type { ConversationContinuationRead, ConversationContinuationSource } from '@/live/work-data-source'
import { Req } from '@/spec/req'
import { useStore } from '@/store'
import type { ContinuablePlatform } from '../../../../shared/conversation-continuation.ts'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Words from live/conversation-continuation.ts in the page's language: `english` is the catalog key. */
const inPageLanguage = (words: ContinuationWords) => interpolate(t(words.english), words.values)

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

/** The two quiet buttons under the message box: smaller than Send, and tall enough for a finger on a phone. */
const QUIET_ACTION = 'h-11 text-muted-foreground md:h-7'

/** One quiet line saying a conversation can't be continued from here, and why when the worker said. */
function CannotContinueLine({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 break-words text-xs text-muted-foreground">
      <CircleSlashIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0">{children}</span>
    </p>
  )
}

/**
 * A folder path on one line. When the line is too narrow for it, the parent folders give way and the folder's own name
 * stays (folderPathForDisplay). The whole path is always its text, for a screen reader and for hover, and a click or
 * Enter shows it whole on as many lines as it needs.
 */
function FolderPath({ folder }: { folder: string }) {
  const [wholePathIsShown, setWholePathIsShown] = useState(false)
  const { parentWithSeparator, folderName } = folderPathForDisplay(folder)
  return (
    // Named with the path as it is: read from its two parts, a screen reader would put a space where they meet.
    <button type="button" title={folder} aria-label={folder} aria-expanded={wholePathIsShown} onClick={() => setWholePathIsShown((isShown) => !isShown)}
      className={cn('min-w-0 rounded-sm text-left font-mono text-[0.7rem] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
        wholePathIsShown ? 'break-all' : 'flex max-w-full')}>
      {wholePathIsShown ? folder : <><span className="truncate">{parentWithSeparator}</span><span className="max-w-full shrink-0 truncate text-foreground/85">{folderName}</span></>}
    </button>
  )
}

/**
 * Where a turn sent from this row runs, as one quiet line above the message box: the catalog's sentence, with its folder
 * drawn as a path (FolderPath). When the recorded folder is gone the sentence says so, before anything is sent.
 */
function WhereItRuns({ id, words, folderIsGone = false }: { id: string; words: ContinuationWords; folderIsGone?: boolean }) {
  const sentence = sentenceAroundFolder(t(words.english), words)
  const Icon = folderIsGone ? FolderXIcon : FolderIcon
  return (
    // The sentence's words keep their own spaces (a language may put none between the folder and the word after it), and
    // the folder takes what is left of the line. The sentence for a folder that is gone is longer, so its line may wrap.
    <p id={id} className={cn('flex min-w-0 items-baseline text-xs whitespace-pre-wrap text-muted-foreground', folderIsGone && 'flex-wrap')}>
      <Icon aria-hidden="true" className="mr-1.5 size-3.5 shrink-0 self-center" />
      {sentence ? <><span className={folderIsGone ? undefined : 'shrink-0'}>{sentence.wordsBefore}</span><FolderPath folder={sentence.folder} /><span className="shrink-0">{sentence.wordsAfter}</span></> : inPageLanguage(words)}
    </p>
  )
}

/**
 * Why the last read of the conversation failed, and "Try again" beside it, which the sentence describes for a screen reader.
 * While the read it asked for is on its way, the button says so in place of its label, and keeps its width.
 */
function ReadFailure({ view, onTryAgain }: { view: ConversationReadFailureView; onTryAgain: (pressedButton: HTMLButtonElement) => void }) {
  useI18n()
  const failureId = useId()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p id={failureId} role="alert" className="break-words text-sm text-muted-foreground">{view.failureText}</p>
      <Button variant="outline" size="sm" className="h-11 md:h-8" aria-describedby={failureId}
        onClick={(event) => onTryAgain(event.currentTarget)}>
        <LabelsInOnePlace labels={buttonLabelsKeepingTheirWidth(t(view.tryAgainLabel), t(view.tryingAgainLabel), view.isTryingAgain)} />
      </Button>
    </div>
  )
}

/** Under one conversation's line: a box to continue it, or one line saying why it can't be continued from here. */
export function ConversationContinue({ platform, conversationSessionId, toolName, conversationTitle, anotherConversationHasTheSameTitle = false }: {
  /** The platform its conversation key records, such as "claude" or "codex". */
  platform: string
  conversationSessionId: string
  /** The tool's name as its line shows it, such as "Claude Code". */
  toolName: string
  /** The conversation's title as its line shows it. Its Send and Stop name it for a screen reader. */
  conversationTitle: string
  /**
   * Another conversation listed beside this one shows the same title. Codex session ids are time-ordered, so
   * conversations started within a minute share their first characters, and the title made from them. The box's
   * label, Send and Stop then add the last eight characters of this session id, so the rows can be told apart.
   */
  anotherConversationHasTheSameTitle?: boolean
}) {
  useI18n()
  const source = useStore((state) => state.conversationContinuationSource())
  // Only the page this computer's worker serves can run a CLI here; sample data and a cloud-served page add nothing.
  if (!source) return null
  const conversation = { platform, conversationSessionId }
  if (!isContinuableConversation(conversation)) {
    return <Req ids={['R2.8']}><CannotContinueLine>{t('This conversation can’t be continued from here.')}</CannotContinueLine></Req>
  }
  const names = conversationControlNames({ toolName, conversationTitle, conversationSessionId, anotherConversationHasTheSameTitle })
  return (
    <Req ids={['R2.8']}>
      <ContinuableConversation source={source} platform={conversation.platform} conversationSessionId={conversationSessionId}
        boxLabel={inPageLanguage(names.messageBox)} sendButtonName={inPageLanguage(names.sendButton)} stopButtonName={inPageLanguage(names.stopButton)}
        toolName={toolName} conversationTitle={conversationTitle} anotherConversationHasTheSameTitle={anotherConversationHasTheSameTitle} />
    </Req>
  )
}

function ContinuableConversation({
  source, platform, conversationSessionId, boxLabel, sendButtonName, stopButtonName, toolName, conversationTitle, anotherConversationHasTheSameTitle,
}: {
  source: ConversationContinuationSource
  platform: ContinuablePlatform
  conversationSessionId: string
  boxLabel: string
  /** What Send and Stop are called for a screen reader: they say which conversation they act on. */
  sendButtonName: string
  stopButtonName: string
  /** As ConversationContinue's: the buttons beside Send are named with them (conversationAppActions). */
  toolName: string
  conversationTitle: string
  anotherConversationHasTheSameTitle: boolean
}) {
  useI18n()
  const [read, setRead] = useState<ConversationContinuationRead | null>(null)
  /** Why the newest read that answered failed. Only a read's answer changes it: "Try again" leaves it on screen. */
  const [readFailure, setReadFailure] = useState<string | null>(null)
  /** "Try again" was pressed, and no read has answered since (conversationReadFailureView). */
  const [tryingAgain, setTryingAgain] = useState(false)
  const [typedMessage, setTypedMessage] = useState('')
  const [sending, setSending] = useState(false)
  /** Why the last Send or Stop did not happen, in the worker's words. */
  const [actionFailure, setActionFailure] = useState<string | null>(null)
  /**
   * The running exchange a Stop was sent for, as one exchange of one worker's life (ExchangeAStopWasSentFor). Its button
   * waits for the turn to end: a second Stop would change nothing. A worker restart counts exchanges from 1 again, and the
   * first one it starts is never taken for this one.
   */
  const [exchangeAStopWasSentFor, setExchangeAStopWasSentFor] = useState<ExchangeAStopWasSentFor | null>(null)
  /** Reads the conversation again. Null once the row is closed. */
  const readAgain = useRef<(() => void) | null>(null)
  /** Where focus goes after Send or Stop (focusAfterSendOrStop): the message box, or this whole box when there is none. */
  const messageBox = useRef<HTMLTextAreaElement>(null)
  const conversationBox = useRef<HTMLDivElement>(null)
  /** Ties the folder-gone notice to the message box, so a screen reader says it when the box is focused. */
  const folderGoneNoticeId = useId()
  /** The folder line while the folder exists, tied to the message box the same way. */
  const runsInFolderNoticeId = useId()
  /** The worker is still opening this conversation in its tool's app. */
  const [openingInApp, setOpeningInApp] = useState(false)
  /** Why the last "Open in" did not open it, in the worker's words, with what the CLI printed. */
  const [openInAppFailure, setOpenInAppFailure] = useState<string | null>(null)
  /** What the CLI printed as the last "Open in" opened it, such as "Opening session … in Claude Desktop". */
  const [openedInAppPrintedText, setOpenedInAppPrintedText] = useState<string | null>(null)
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

  // Reads the conversation when the row opens, then again on each notice about it and each reopened live stream, so a
  // row never stays on a missed notice. Only the newest read is shown: an older answer that arrives late is dropped.
  useEffect(() => {
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

  const readFailureView = conversationReadFailureView(readFailure, tryingAgain)
  /**
   * Reads the conversation again after a failed read. The reason and the button stay until a read answers, and the button
   * says it is trying again (conversationReadFailureView). A read that answers takes the button away, so focus moves into
   * this box first when the row has one, as after Send.
   */
  const tryReadingAgain = (pressedButton: HTMLButtonElement) => {
    if (read) {
      const focusTarget = focusAfterSendOrStop(document.activeElement === pressedButton, continuationView(read.target, read.exchanges, typedMessage))
      if (focusTarget === 'message-box') messageBox.current?.focus()
      if (focusTarget === 'conversation-box') conversationBox.current?.focus()
    }
    setTryingAgain(true)
    readAgain.current?.()
  }
  if (!read) return readFailureView ? <ReadFailure view={readFailureView} onTryAgain={tryReadingAgain} /> : null
  const view = continuationView(read.target, read.exchanges, typedMessage, exchangeAStopWasSentFor)
  const appActions = conversationAppActions({ platform, conversationSessionId, toolName, conversationTitle, anotherConversationHasTheSameTitle },
    read.target, source.openConversationInApp !== undefined)
  const copyFailureWords = resumeCommandCopyFailure === null ? null : resumeCommandCopyFailureWords(resumeCommandCopyFailure)

  const openInApp = async () => {
    const openConversationInApp = source.openConversationInApp
    if (!openConversationInApp || openingInApp) return
    setOpeningInApp(true)
    setOpenInAppFailure(null)
    setOpenedInAppPrintedText(null)
    try {
      const opened = await openConversationInApp(platform, conversationSessionId)
      setOpenedInAppPrintedText(opened.printedText)
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

  /** The pressed button is disabled next, or goes away, so the owner's place moves into this box first. */
  const keepFocusInConversation = (pressedButton: HTMLButtonElement) => {
    const focusTarget = focusAfterSendOrStop(document.activeElement === pressedButton, view)
    if (focusTarget === 'message-box') messageBox.current?.focus()
    if (focusTarget === 'conversation-box') conversationBox.current?.focus()
  }

  /** `pressedButton` is Send when it was pressed. Cmd/Ctrl+Enter sends from the box, which keeps focus. */
  const send = async (pressedButton?: HTMLButtonElement) => {
    if (!view.sendIsEnabled || sending) return
    if (pressedButton) keepFocusInConversation(pressedButton)
    setSending(true)
    setActionFailure(null)
    try {
      await source.continueConversation(platform, conversationSessionId, typedMessage)
      setTypedMessage('')
      // The list shown is always the worker's: read it now rather than wait for the notice.
      readAgain.current?.()
    } catch (error) {
      // What was typed stays in the box, so it can be sent again.
      setActionFailure(messageOf(error))
    } finally {
      setSending(false)
    }
  }

  const stop = async (exchange: ExchangeAStopWasSentFor, pressedButton: HTMLButtonElement) => {
    keepFocusInConversation(pressedButton)
    setExchangeAStopWasSentFor({ exchangeId: exchange.exchangeId, startedAtEpochMs: exchange.startedAtEpochMs })
    setActionFailure(null)
    try {
      // The exchange stays running until the CLI has exited; the notice that it ended reads this row again.
      await source.stopConversationContinuation(platform, conversationSessionId)
    } catch (error) {
      setExchangeAStopWasSentFor(null)
      setActionFailure(messageOf(error))
    }
  }

  return (
    // Focusable from script only when there is no message box, so a pressed Stop can leave focus here.
    <div ref={conversationBox} tabIndex={view.composerIsShown ? undefined : -1} className="space-y-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      {/* First, as the conversation line's second line: where a turn sent from here runs. It is what tells one conversation from the next. */}
      {view.folderGoneNotice && <WhereItRuns id={folderGoneNoticeId} words={view.folderGoneNotice} folderIsGone />}
      {appActions?.runsInFolderNotice && <WhereItRuns id={runsInFolderNoticeId} words={appActions.runsInFolderNotice} />}
      {view.exchanges.length > 0 && (
        // Read like a chat: what the owner sent on the right, what the conversation answered on the left under its tool's name.
        <div className="space-y-3 py-1" aria-live="polite">
          {view.exchanges.map((exchange) => (
            <div key={exchange.exchangeId} className="space-y-2 text-sm">
              <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 whitespace-pre-wrap break-words text-secondary-foreground">{exchange.ownerMessage}</p>
              <div className="space-y-1.5">
                <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <AgentMark tool={platform} className="size-3.5" />
                  <span className="font-medium text-foreground">{toolName}</span>
                  {exchange.state === 'running'
                    ? <Shimmer as="span">{t(exchange.stateWords)}</Shimmer>
                    : <span className={exchange.state === 'failed' ? 'text-destructive' : undefined}>{t(exchange.stateWords)}</span>}
                  {exchange.state === 'running' && view.stopIsShown && (
                    <Button variant="outline" size="sm" className="ml-auto h-11 md:h-8" aria-label={stopButtonName} disabled={exchange.stopWasSent}
                      onClick={(event) => void stop(exchange, event.currentTarget)}><SquareIcon aria-hidden="true" className="fill-current" />{t('Stop')}</Button>
                  )}
                </div>
                {exchange.replyText !== null && <p className="whitespace-pre-wrap break-words">{exchange.replyText}</p>}
                {exchange.failureText !== null && (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words">{exchange.failureText}</p>
                )}
                {exchange.notices.map((notice) => <p key={notice.english} className="text-xs text-muted-foreground">{inPageLanguage(notice)}</p>)}
              </div>
            </div>
          ))}
        </div>
      )}
      {view.refusalText !== null && <CannotContinueLine>{view.refusalText}</CannotContinueLine>}
      {view.composerIsShown && (
        <>
          {/* The message box and Send are one box, with Send in the page's main color, so it reads as a place to type and send. */}
          <div
            className="flex cursor-text items-end gap-2 rounded-xl border border-input bg-card p-1.5 shadow-[inset_0_1px_2px_rgb(74_46_20/0.05)] transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30"
            // A click on the box's own edge, outside the words and the button, still lands in the message box.
            onClick={(event) => { if (event.target === event.currentTarget) messageBox.current?.focus() }}>
            <Textarea
              ref={messageBox}
              aria-label={boxLabel}
              aria-describedby={view.folderGoneNotice ? folderGoneNoticeId : appActions?.runsInFolderNotice ? runsInFolderNoticeId : undefined}
              placeholder={boxLabel}
              value={typedMessage}
              // One line until words need more: the box grows with what is typed (field-sizing-content), so a request that
              // lists many conversations stays short. A browser without field-sizing shows two lines.
              rows={2}
              className="min-h-0 flex-1 resize-none self-center border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
              // Read-only while Send is in flight: a successful Send clears the box, which would lose words typed meanwhile.
              readOnly={sending}
              onChange={(event) => setTypedMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            {/* In the page's main color once there are words to send. Until then it is quiet, so a long list of conversations is not a column of orange. */}
            <Button variant={view.sendIsEnabled || sending ? 'default' : 'outline'} size="sm" className="h-11 md:h-8" aria-label={sendButtonName} aria-keyshortcuts="Meta+Enter Control+Enter" disabled={!view.sendIsEnabled || sending}
              onClick={(event) => void send(event.currentTarget)}>
              <LabelsInOnePlace labels={buttonLabelsKeepingTheirWidth(t('Send'), t('Sending…'), sending)} />
              {/* The keys that send from the box, shown where a keyboard is likely. Enter alone starts a new line: a Send starts a real turn. */}
              <kbd aria-hidden="true" className="hidden font-sans text-[0.7rem] opacity-75 md:inline">{SEND_KEYS_HINT}</kbd>
            </Button>
          </div>
          {/* Under the box, quietly: the two other ways into this conversation. */}
          <div className="flex flex-wrap items-center justify-end gap-x-1">
            {appActions?.openInApp && (
              // aria-disabled, not disabled, while it opens: a disabled button drops focus to the page, so the owner keeps their place.
              <Button variant="ghost" size="xs" className={QUIET_ACTION} aria-label={inPageLanguage(appActions.openInApp.buttonName)} aria-disabled={openingInApp}
                onClick={() => void openInApp()}>
                <ExternalLinkIcon aria-hidden="true" />
                <LabelsInOnePlace labels={buttonLabelsKeepingTheirWidth(inPageLanguage(appActions.openInApp.label), t('Opening…'), openingInApp)} />
              </Button>
            )}
            {appActions && (
              <Button ref={copyButton} variant="ghost" size="xs" className={QUIET_ACTION}
                aria-label={inPageLanguage(resumeCommandCopied ? appActions.copyResumeCommand.copiedButtonName : appActions.copyResumeCommand.buttonName)}
                onClick={() => void copyResumeCommand(appActions.copyResumeCommand.command)}>
                {resumeCommandCopied ? <CheckIcon aria-hidden="true" /> : <TerminalIcon aria-hidden="true" />}
                {resumeCommandCopied ? t('Copied') : t('Copy resume command')}
              </Button>
            )}
          </div>
          {openedInAppPrintedText !== null && (
            <p role="status" className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{openedInAppPrintedText}</p>
          )}
          {openInAppFailure && <p role="alert" className="whitespace-pre-wrap break-words text-sm">{openInAppFailure}</p>}
          {appActions && copyFailureWords && (
            <div className="space-y-1">
              <div role="alert" className="break-words text-xs text-muted-foreground">
                <p>{inPageLanguage(copyFailureWords.why)}</p>
                <p>{inPageLanguage(copyFailureWords.copyItFromHere)}</p>
              </div>
              <p className="select-all break-words font-mono text-xs">{appActions.copyResumeCommand.command}</p>
            </div>
          )}
        </>
      )}
      {actionFailure && <p role="alert" className="break-words text-sm font-medium">{actionFailure}</p>}
      {readFailureView && <ReadFailure view={readFailureView} onTryAgain={tryReadingAgain} />}
    </div>
  )
}
