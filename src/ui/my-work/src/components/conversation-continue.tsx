// Continue a conversation where it is listed: the owner types under a Claude Code or Codex conversation, that same
// conversation takes the message as one turn, and its reply shows here. One self-contained, layout-free block under a
// conversation's line, so any list of conversations can mount it (the request drawer's "Where this came from" does).
// What it shows is decided by continuationView (live/conversation-continuation.ts). The worker's record is the state:
// each open row reads it, and reads it again on every notice about its conversation, so nothing here is stored.
import { useEffect, useId, useRef, useState } from 'react'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { interpolate, t, useI18n } from '@/lib/i18n'
import {
  continuationEventConcernsConversation, continuationView, conversationControlNames, focusAfterSendOrStop, isContinuableConversation,
  type ContinuationWords,
} from '@/live/conversation-continuation'
import type { ConversationContinuationRead, ConversationContinuationSource } from '@/live/work-data-source'
import { Req } from '@/spec/req'
import { useStore } from '@/store'
import type { ContinuablePlatform } from '../../../../shared/conversation-continuation.ts'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Words from live/conversation-continuation.ts in the page's language: `english` is the catalog key. */
const inPageLanguage = (words: ContinuationWords) => interpolate(t(words.english), words.values)

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
    return <Req ids={['R2.8']}><p className="text-sm text-muted-foreground">{t('This conversation can’t be continued from here.')}</p></Req>
  }
  const names = conversationControlNames({ toolName, conversationTitle, conversationSessionId, anotherConversationHasTheSameTitle })
  return (
    <Req ids={['R2.8']}>
      <ContinuableConversation source={source} platform={conversation.platform} conversationSessionId={conversationSessionId}
        boxLabel={inPageLanguage(names.messageBox)} sendButtonName={inPageLanguage(names.sendButton)} stopButtonName={inPageLanguage(names.stopButton)} />
    </Req>
  )
}

function ContinuableConversation({ source, platform, conversationSessionId, boxLabel, sendButtonName, stopButtonName }: {
  source: ConversationContinuationSource
  platform: ContinuablePlatform
  conversationSessionId: string
  boxLabel: string
  /** What Send and Stop are called for a screen reader: they say which conversation they act on. */
  sendButtonName: string
  stopButtonName: string
}) {
  useI18n()
  const [read, setRead] = useState<ConversationContinuationRead | null>(null)
  const [readFailure, setReadFailure] = useState<string | null>(null)
  const [typedMessage, setTypedMessage] = useState('')
  const [sending, setSending] = useState(false)
  /** Why the last Send or Stop did not happen, in the worker's words. */
  const [actionFailure, setActionFailure] = useState<string | null>(null)
  /** The running exchange a Stop was sent for. Its button waits for the turn to end: a second Stop would change nothing. */
  const [stopSentForExchangeId, setStopSentForExchangeId] = useState<number | null>(null)
  /** Reads the conversation again. Null once the row is closed. */
  const readAgain = useRef<(() => void) | null>(null)
  /** Where focus goes after Send or Stop (focusAfterSendOrStop): the message box, or this whole box when there is none. */
  const messageBox = useRef<HTMLTextAreaElement>(null)
  const conversationBox = useRef<HTMLDivElement>(null)
  /** Ties the folder-gone notice to the message box, so a screen reader says it when the box is focused. */
  const folderGoneNoticeId = useId()

  // Reads the conversation when the row opens, then again on each notice about it and each reopened live stream, so a
  // row never stays on a missed notice. Only the newest read is shown: an older answer that arrives late is dropped.
  useEffect(() => {
    let rowIsOpen = true
    let newestRead = 0
    const readConversation = () => {
      const thisRead = ++newestRead
      source.loadConversationContinuation(platform, conversationSessionId).then(
        (answer) => { if (rowIsOpen && thisRead === newestRead) { setRead(answer); setReadFailure(null) } },
        (error: unknown) => { if (rowIsOpen && thisRead === newestRead) setReadFailure(messageOf(error)) },
      )
    }
    readAgain.current = readConversation
    readConversation()
    const stopHearing = source.subscribeToConversationContinuations((event) => {
      if (continuationEventConcernsConversation(event, { platform, conversationSessionId })) readConversation()
    })
    return () => { rowIsOpen = false; readAgain.current = null; stopHearing() }
  }, [source, platform, conversationSessionId])

  if (!read) return readFailure ? <p role="alert" className="break-words text-sm text-muted-foreground">{readFailure}</p> : null
  const view = continuationView(read.target, read.exchanges, typedMessage)

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

  const stop = async (exchangeId: number, pressedButton: HTMLButtonElement) => {
    keepFocusInConversation(pressedButton)
    setStopSentForExchangeId(exchangeId)
    setActionFailure(null)
    try {
      // The exchange stays running until the CLI has exited; the notice that it ended reads this row again.
      await source.stopConversationContinuation(platform, conversationSessionId)
    } catch (error) {
      setStopSentForExchangeId(null)
      setActionFailure(messageOf(error))
    }
  }

  return (
    // Focusable from script only when there is no message box, so a pressed Stop can leave focus here.
    <div ref={conversationBox} tabIndex={view.composerIsShown ? undefined : -1} className="space-y-2">
      {view.exchanges.length > 0 && (
        <div className="space-y-2" aria-live="polite">
          {view.exchanges.map((exchange) => (
            <div key={exchange.exchangeId} className="space-y-1 border-l-2 pl-3 text-sm">
              <p className="whitespace-pre-wrap break-words text-muted-foreground">{exchange.ownerMessage}</p>
              {exchange.state === 'running' ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Shimmer as="span" className="text-xs">{t(exchange.stateWords)}</Shimmer>
                  {view.stopIsShown && (
                    <Button variant="outline" size="sm" className="h-11 md:h-8" aria-label={stopButtonName} disabled={stopSentForExchangeId === exchange.exchangeId}
                      onClick={(event) => void stop(exchange.exchangeId, event.currentTarget)}>{t('Stop')}</Button>
                  )}
                </div>
              ) : <p className="text-xs text-muted-foreground">{t(exchange.stateWords)}</p>}
              {exchange.replyText !== null && <p className="whitespace-pre-wrap break-words">{exchange.replyText}</p>}
              {exchange.failureText !== null && <p className="whitespace-pre-wrap break-words">{exchange.failureText}</p>}
              {exchange.notices.map((notice) => <p key={notice.english} className="text-xs text-muted-foreground">{inPageLanguage(notice)}</p>)}
            </div>
          ))}
        </div>
      )}
      {view.refusalText !== null && <p className="break-words text-sm text-muted-foreground">{view.refusalText}</p>}
      {view.composerIsShown && (
        <>
          {view.folderGoneNotice && <p id={folderGoneNoticeId} className="break-words text-xs text-muted-foreground">{inPageLanguage(view.folderGoneNotice)}</p>}
          <Textarea
            ref={messageBox}
            aria-label={boxLabel}
            aria-describedby={view.folderGoneNotice ? folderGoneNoticeId : undefined}
            placeholder={boxLabel}
            value={typedMessage}
            rows={2}
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
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" className="h-11 md:h-8" aria-label={sendButtonName} disabled={!view.sendIsEnabled || sending}
              onClick={(event) => void send(event.currentTarget)}>{sending ? t('Sending…') : t('Send')}</Button>
          </div>
        </>
      )}
      {actionFailure && <p role="alert" className="break-words text-sm font-medium">{actionFailure}</p>}
      {readFailure && <p role="alert" className="break-words text-sm text-muted-foreground">{readFailure}</p>}
    </div>
  )
}
