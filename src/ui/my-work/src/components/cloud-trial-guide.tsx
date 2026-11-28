import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { CloudTrialClientPicker } from '@/components/cloud-trial-client-picker'
import { interpolate, useI18n } from '@/lib/i18n'
import { PRIMARY_TRIAL_CLIENTS, SCHEDULING_TRIAL_CLIENTS, type TrialClient } from '@/live/cloud-trial-clients'
import { FIRST_TRIAL_ROUTINE_DAY, TRIAL_CONNECT_TASK, TRIAL_GUIDE_STEPS, trialGuideStep, type TrialGuideStep } from '@/live/cloud-trial-guide'
import { useStore } from '@/store'

/** A copied schedule is a request to the selected host. That host owns the saved task and its next run. */
function TrialGuideActivity({ step, client, onSelect }: {
  step: TrialGuideStep; client: TrialClient; onSelect: (client: TrialClient) => void
}) {
  const { t } = useI18n()
  const [scheduling, setScheduling] = useState(false)
  const [time, setTime] = useState(step.schedule?.defaultTime ?? '')
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const pickerClient = scheduling && !client.scheduleHelp ? SCHEDULING_TRIAL_CLIENTS[0] : client
  const scheduleRequest = scheduling && step.schedule && time
    ? interpolate(t(step.schedule.request), { time, zone }) : undefined

  return (
    <>
      <p className="my-2 text-sm text-muted-foreground">{scheduling
        ? t('Choose when to run it. Scheduled tasks need a host account with scheduling and access to Claude-Mem.')
        : t(step.instruction)}</p>
      {step.opensFocus && <div className="mb-3 flex flex-wrap gap-2">
        <Button type="button" className="min-h-11" onClick={() => useStore.getState().goToPage('focus')}>{t('Open Focus Areas')}</Button>
        <Button type="button" variant="outline" className="min-h-11" onClick={() => useStore.getState().goToPage('requests')}>{t('All requests')}</Button>
      </div>}
      {scheduling && <label className="mb-3 flex flex-wrap items-center gap-2 text-sm font-medium">
        {interpolate(t('Run time ({zone})'), { zone })}
        <input type="time" required className="min-h-11 rounded-md border border-control-edge bg-background px-2 text-foreground"
          value={time} onChange={event => setTime(event.target.value)} />
      </label>}
      {(!scheduling || time) && <CloudTrialClientPicker key={scheduling ? 'schedule-' + time : 'preview'}
        client={pickerClient} onSelect={onSelect} connecting={false} writing={Boolean(step.writesNote)}
        task={step.prompt} scheduleRequest={scheduleRequest} />}
      {step.schedule && <Button type="button" className="mt-2 min-h-11" variant={scheduling ? 'outline' : 'default'}
        onClick={() => setScheduling(!scheduling)}>{t(scheduling ? 'Back to preview' : 'Set up this schedule')}</Button>}
    </>
  )
}

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
  const stepIndex = TRIAL_GUIDE_STEPS.findIndex(item => String(item.day) === selected)
  const step = TRIAL_GUIDE_STEPS[stepIndex] ?? suggested
  const nextStep = TRIAL_GUIDE_STEPS[stepIndex + 1]

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
        <h2 id={id + '-heading'} className="font-semibold">{t('Use Cloud Sync')}</h2>
        <Button type="button" variant="ghost" className="min-h-11" aria-expanded={!hidden} aria-controls={id} onClick={toggle}>
          {t(hidden ? 'Show guide' : 'Hide guide')}
        </Button>
      </div>
      <div id={id} hidden={hidden}>
        <label className="mt-1 block text-sm font-medium">
          {t('What would you like to try?')}
          <select className="ml-0 block min-h-11 max-w-full rounded-md border border-control-edge bg-background px-2 text-foreground sm:ml-2 sm:inline"
            value={selected} onChange={event => setChoice(event.target.value)}>
            <option value="connect">{t('Connect an agent')}</option>
            {TRIAL_GUIDE_STEPS.map(item => <option key={item.day} value={item.day}>{t(item.title)}</option>)}
          </select>
        </label>
        {(connecting || step.writesNote) && <Button type="button" variant="link" className="min-h-11 px-0"
          onClick={() => setChoice(String(FIRST_TRIAL_ROUTINE_DAY))}>{t('Try a morning brief')}</Button>}
        <div className="mt-3">
          {connecting ? <CloudTrialClientPicker client={client} onSelect={setClient} connecting writing={false} task={TRIAL_CONNECT_TASK} />
            : <TrialGuideActivity key={selected} step={step} client={client} onSelect={setClient} />}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4">
          {nextStep && <Button type="button" variant="outline" className="min-h-11 max-w-full whitespace-normal" onClick={() => setChoice(String(nextStep.day))}>
            {connecting ? t('Continue to handoff') : interpolate(t('Next: {activity}'), { activity: t(nextStep.title) })}
          </Button>}
          <a className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline" href="https://cmem.ai/connect">{t('Connect another agent')}</a>
        </div>
      </div>
    </section>
  )
}
