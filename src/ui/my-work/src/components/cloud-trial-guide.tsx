import { useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import { TRIAL_GUIDE_STEPS, trialGuideStep } from '@/live/cloud-trial-guide'

export function CloudTrialGuide({ startedAt }: { startedAt: string }) {
  const { t } = useI18n()
  const id = useId()
  const storageKey = 'cmem-work-handoff-guide-' + startedAt
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(storageKey) === 'hidden' } catch { return false }
  })
  const suggested = trialGuideStep(startedAt)
  const [choice, setChoice] = useState<typeof suggested | null>(null)
  const step = choice ?? suggested
  const prompt = t(step.prompt)
  const text = useRef<HTMLTextAreaElement>(null)
  const [copyMessage, setCopyMessage] = useState('')

  const toggle = () => {
    setHidden(!hidden)
    try {
      if (hidden) localStorage.removeItem(storageKey)
      else localStorage.setItem(storageKey, 'hidden')
    } catch { /* The preference still works in this open page. */ }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopyMessage('Prompt copied')
    } catch {
      text.current?.focus()
      text.current?.select()
      setCopyMessage('The prompt is selected. Use your device’s Copy command.')
    }
  }

  return (
    <section aria-labelledby={id + '-heading'} className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <h2 id={id + '-heading'} className="font-semibold">{t('Cross-agent handoff guide')}</h2>
        <Button type="button" variant="ghost" className="min-h-11" aria-expanded={!hidden} aria-controls={id} onClick={toggle}>
          {t(hidden ? 'Show guide' : 'Hide guide')}
        </Button>
      </div>
      <div id={id} hidden={hidden}>
        <label className="mt-1 block text-sm font-medium">
          {t('Handoff step')}
          <select className="ml-0 block min-h-11 max-w-full rounded-md border border-control-edge bg-background px-2 text-foreground sm:ml-2 sm:inline"
            value={step.day} onChange={event => { setChoice(TRIAL_GUIDE_STEPS.find(item => item.day === Number(event.target.value)) ?? suggested); setCopyMessage('') }}>
            {TRIAL_GUIDE_STEPS.map(item => <option key={item.day} value={item.day}>{t(item.title)}</option>)}
          </select>
        </label>
        <p className="my-2 text-sm text-muted-foreground">{t(step.instruction)}</p>
        <textarea ref={text} aria-label={t('Prompt for your agent')} readOnly value={prompt} rows={3}
          className="block min-h-24 w-full resize-y rounded-md border border-control-edge bg-background px-3 py-2 text-sm text-foreground" />
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <Button type="button" variant="outline" className="min-h-11" onClick={copy}>{t('Copy prompt')}</Button>
          <a className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline" href="https://cmem.ai/connect">{t('Connect another agent')}</a>
          <span role="status" className="text-sm text-muted-foreground">{t(copyMessage)}</span>
        </div>
      </div>
    </section>
  )
}
