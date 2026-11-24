import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { CloudTrialClientPicker } from '@/components/cloud-trial-client-picker'
import { useI18n } from '@/lib/i18n'
import { PRIMARY_TRIAL_CLIENTS } from '@/live/cloud-trial-clients'
import { TRIAL_CONNECT_TASK, TRIAL_GUIDE_STEPS, trialGuideStep } from '@/live/cloud-trial-guide'

export function CloudTrialGuide({ startedAt }: { startedAt: string }) {
  const { t } = useI18n()
  const id = useId()
  const storageKey = 'cmem-work-handoff-guide-' + startedAt
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(storageKey) === 'hidden' } catch { return false }
  })
  const suggested = trialGuideStep(startedAt)
  const [client, setClient] = useState(PRIMARY_TRIAL_CLIENTS[0])
  const [choice, setChoice] = useState<string | null>(null)
  const selected = choice ?? (suggested.day === 1 ? 'connect' : String(suggested.day))
  const connecting = selected === 'connect'
  const step = TRIAL_GUIDE_STEPS.find(item => String(item.day) === selected) ?? suggested

  const toggle = () => {
    setHidden(!hidden)
    try {
      if (hidden) localStorage.removeItem(storageKey)
      else localStorage.setItem(storageKey, 'hidden')
    } catch { /* The preference still works in this open page. */ }
  }

  return (
    <section aria-labelledby={id + '-heading'} className="min-w-0 rounded-xl border border-border bg-card px-4 py-3">
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
            value={selected} onChange={event => setChoice(event.target.value)}>
            <option value="connect">{t('Connect an agent')}</option>
            {TRIAL_GUIDE_STEPS.map(item => <option key={item.day} value={item.day}>{t(item.title)}</option>)}
          </select>
        </label>
        {!connecting && <p className="my-2 text-sm text-muted-foreground">{t(step.instruction)}</p>}
        <div className="mt-3">
          <CloudTrialClientPicker key={selected} client={client} onSelect={setClient} connecting={connecting} writing={!connecting && step.day !== 3} task={connecting ? TRIAL_CONNECT_TASK : step.prompt} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4">
          {connecting && <Button type="button" variant="outline" className="min-h-11" onClick={() => setChoice(String(suggested.day))}>{t('Continue to handoff')}</Button>}
          <a className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline" href="https://cmem.ai/connect">{t('Connect another agent')}</a>
        </div>
      </div>
    </section>
  )
}
