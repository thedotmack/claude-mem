// Answering the agent from the request page. Send hands the answer to the request's own session as one turn (one
// click, at most one run), and the page says how the delivery went. The question and the last delivery are separate
// facts (owner-runs-model.ts answerPanel): a delivery on its way, or one that failed, shows with or without a question.
import { useState } from 'react'
import { SendIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { Req } from '@/spec/req'
import type { Request } from '@/data'
import { useStore } from '@/store'
import { answerPanel } from '@/live/owner-runs-model'
import { cn } from '@/lib/utils'
import { MAX_ANSWER_CHARS, type AnswerRunState } from '../../../../services/work-view/owner-runs.mjs'
import type { QuestionNeed } from '../../../../services/work-view/question-needs.mjs'
import { ChatLink } from './chat-link'

const ANSWER_STATE: Record<AnswerRunState, string> = { answering: 'Sending…', delivered: 'Delivered', failed: 'Not delivered' }
const QUESTION_NEED: Record<QuestionNeed, string> = { answer: 'Your agent is waiting for your answer', approval: 'Your agent is waiting for your approval' }
const CONTROL = 'h-11 shrink-0 md:h-8'

type CopyState = 'copied' | 'failed' | null

function CopyText({ text }: { text: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState<CopyState>(null)
  const copy = () => navigator.clipboard.writeText(text).then(() => setCopied('copied'), () => setCopied('failed'))
  return <Button variant="outline" size="sm" className={CONTROL} onClick={() => void copy()}><span role="status">{copied === 'copied' ? t('Copied') : copied === 'failed' ? t('Couldn’t copy') : t('Copy')}</span></Button>
}

/** The question, what the owner may need to know to answer it, and the box. A refusal keeps the answer in the box and copies it. */
function AnswerBox({ request, question, delivering }: { request: Request; question: NonNullable<Request['question']>; delivering: boolean }) {
  const { t } = useI18n()
  // The draft lives in the store: the page reads the request's detail again whenever the request changes, and what
  // was typed must outlive that. A draft written for another question is not this question's.
  const draft = useStore((state) => state.work.answerDrafts[request.id])
  const answer = draft?.version === question.version ? draft.text : ''
  const setAnswer = (text: string) => useStore.getState().draftAnswer(request.id, question.version, text)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<{ text: string; openChat?: true } | null>(null)
  const send = async () => {
    const text = answer.trim()
    if (!text) { setNotice({ text: t('Write an answer first.') }); return }
    setSending(true)
    setNotice(null)
    try {
      const started = await useStore.getState().answerRequest(request.id, text)
      if (started.outcome !== 'refused') return
      const copied = await navigator.clipboard.writeText(text).then(() => true, () => false)
      setNotice({ text: `${started.reason} ${t(copied ? 'Answer copied. Paste it into the chat.' : 'Couldn’t copy your answer. Copy it, then open the chat.')}`, openChat: true })
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error) })
    } finally { setSending(false) }
  }
  return (
    <Req ids={['R20.1']}>
      <form className="space-y-2.5" onSubmit={(event) => { event.preventDefault(); void send() }}>
        <p className="section-label">{t(QUESTION_NEED[question.need])}</p>
        <p className="text-[0.95rem] leading-snug">{question.text}</p>
        {question.background.length > 0 && (
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>{t('What you may need to know')}</p>
            <ul className="list-disc space-y-0.5 pl-5">{question.background.map((item, index) => <li key={index}>{item}</li>)}</ul>
          </div>
        )}
        <Textarea value={answer} onChange={(event) => { setAnswer(event.target.value); setNotice(null) }} aria-label={t('Your answer')} placeholder={t('Your answer')} maxLength={MAX_ANSWER_CHARS} rows={3} className="min-h-20 bg-card text-sm" />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" className={CONTROL} disabled={sending || delivering}><SendIcon />{t('Send to the agent')}</Button>
          <span className="text-xs text-muted-foreground">{t('Resumes this request’s chat with your answer as one turn.')}</span>
        </div>
        {notice && (
          <div role="status" className="space-y-1 text-xs text-muted-foreground">
            <p>{notice.text}</p>
            {notice.openChat && <ChatLink request={request} className="-mx-2" />}
          </div>
        )}
      </form>
    </Req>
  )
}

/** How the last answer's delivery went. A failed one keeps the answer this page sent, to copy, beside the chat link. */
function AnswerDelivery({ request, delivery }: { request: Request; delivery: NonNullable<ReturnType<typeof answerPanel>['delivery']> }) {
  const { t } = useI18n()
  const failed = delivery.state === 'failed'
  return (
    <Req ids={['R20.2']}>
      <div className="space-y-2">
        <p role="status" className={cn('flex items-start gap-1.5 text-xs text-muted-foreground', failed && 'text-attention-foreground')}>
          {delivery.state === 'answering' && <Spinner className="mt-px size-3.5 shrink-0" />}
          <span><span className="font-medium">{t('Your answer')}</span> · {t(ANSWER_STATE[delivery.state])}{failed && delivery.error ? `: ${delivery.error}` : ''}</span>
        </p>
        {failed && (
          <>
            {delivery.text && <blockquote className="border-l-2 pl-3 text-sm whitespace-pre-wrap text-muted-foreground">{delivery.text}</blockquote>}
            <div className="flex flex-wrap items-center gap-1">
              {delivery.text && <CopyText text={delivery.text} />}
              <ChatLink request={request} />
            </div>
            <p className="text-xs text-muted-foreground">{t('Nothing is sent again by itself.')}</p>
          </>
        )}
      </div>
    </Req>
  )
}

export function RequestAnswer({ request }: { request: Request }) {
  const sentText = useStore((state) => state.work.sentAnswers[request.id])
  const { question, delivery } = answerPanel(request, sentText)
  if (!question && !delivery) return null
  return (
    <div className="space-y-3 rounded-xl border p-4 text-sm">
      {/* Keyed by the review the question came from: a new question starts with an empty box and no old notice. */}
      {question && <AnswerBox key={`${question.version}:${question.text}`} request={request} question={question} delivering={delivery?.state === 'answering'} />}
      {delivery && <AnswerDelivery request={request} delivery={delivery} />}
    </div>
  )
}
