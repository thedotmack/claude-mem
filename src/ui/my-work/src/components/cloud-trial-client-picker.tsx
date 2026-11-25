import { useId, useLayoutEffect, useRef, useState } from 'react'
import { CopyIcon, ExternalLinkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { interpolate, useI18n } from '@/lib/i18n'
import { clientHandoffPrompt, clientSetupInstructions, OTHER_TRIAL_CLIENTS, PRIMARY_TRIAL_CLIENTS, SCHEDULING_TRIAL_CLIENTS, type TrialClient } from '@/live/cloud-trial-clients'
import { CMEM_MCP_URL } from '@/setup/agent-connections'
import { ToolMark } from '@/setup/screens/shared'

/** The brand tile copies chat text. Separate controls copy the exact value a settings field or terminal accepts. */
export function CloudTrialClientPicker({ task, connecting, writing, scheduleRequest, client, onSelect }: {
  task: string; connecting: boolean; writing: boolean; scheduleRequest?: string; client: TrialClient; onSelect: (client: TrialClient) => void
}) {
  const { t } = useI18n()
  const id = useId()
  const [moreOpen, setMoreOpen] = useState(OTHER_TRIAL_CLIENTS.includes(client))
  const [showSetup, setShowSetup] = useState(false)
  const [message, setMessage] = useState('')
  const [manualCopy, setManualCopy] = useState<{ id: string } | null>(null)
  const generation = useRef(0)
  const promptId = id + '-prompt'
  const promptFor = (target: TrialClient) => {
    const handoff = clientHandoffPrompt(target, task, t)
    if (scheduleRequest) return scheduleRequest + '\n\n' + handoff
    return writing ? handoff + '\n' + t('If your connection is read-only, tell me so I can save the note in my first agent.') : handoff
  }

  // Wait for the newly selected client's text to be rendered before selecting it for native Copy.
  useLayoutEffect(() => {
    if (!manualCopy) return
    const field = document.getElementById(manualCopy.id) as HTMLTextAreaElement | HTMLInputElement | null
    field?.focus()
    field?.select()
  }, [manualCopy])

  const copy = async (value: string, fieldId: string, success: string) => {
    const request = ++generation.current
    setMessage('')
    try {
      await navigator.clipboard.writeText(value)
      if (request === generation.current) setMessage(success)
    } catch {
      if (request !== generation.current) return
      setManualCopy({ id: fieldId })
      setMessage(t('The text is selected. Use your device’s Copy command.'))
    }
  }

  const tile = (target: TrialClient) => {
    const selected = client.id === target.id
    const name = target.id === 'other-mcp' ? t(target.name) : target.name
    const label = interpolate(t(connecting ? 'Copy setup for {toolName}' : 'Copy prompt for {toolName}'), { toolName: name })
    return (
      <Button key={target.id} type="button" variant="outline" aria-label={label} aria-pressed={selected}
        className="h-auto min-h-16 min-w-0 justify-start gap-2 whitespace-normal px-2 py-2 text-left aria-pressed:border-primary aria-pressed:ring-1 aria-pressed:ring-primary"
        onClick={() => {
          onSelect(target)
          void copy(promptFor(target), promptId, interpolate(t('Prompt copied. Paste it into {toolName}.'), { toolName: name }))
        }}>
        <ToolMark id={target.id === 'gemini-web' ? 'gemini-cli' : target.id} name={name}
          className="grid size-8 shrink-0 place-content-center rounded-md bg-white text-xs font-bold text-slate-900 [&_img]:size-7 [&_img]:object-contain" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold leading-5">{name}</span>
          {target.surface && <span className="block text-xs leading-4 text-muted-foreground">{t(target.surface)}</span>}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs"><CopyIcon aria-hidden="true" className="size-4" />{t('Copy')}</span>
      </Button>
    )
  }

  const name = client.id === 'other-mcp' ? t(client.name) : client.name
  const field = (value: string, index: number, command: boolean) => {
    const fieldId = id + '-setup-' + index
    const destination = command ? (value.startsWith('/') ? t('In your agent') : t('In your terminal')) : t('Connector URL')
    return (
      <div key={fieldId} className="mt-2">
        <label htmlFor={fieldId} className="text-xs font-medium text-muted-foreground">{destination}</label>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <input id={fieldId} readOnly value={value} dir="ltr" className="h-11 w-full min-w-0 flex-1 basis-44 rounded border border-control-edge bg-background px-2 font-mono text-xs" />
          <Button type="button" variant="outline" className="min-h-11" onClick={() => void copy(value, fieldId, command ? t('Command copied.') : t('URL copied.'))}>
            {command ? t('Copy command') : t('Copy URL')}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div>
      <p className="mb-2 text-sm font-medium">{connecting ? t('Choose an agent to copy its setup.') : t('Choose an agent to copy your prompt.')}</p>
      <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2 lg:grid-cols-3">{(scheduleRequest ? SCHEDULING_TRIAL_CLIENTS : PRIMARY_TRIAL_CLIENTS).map(tile)}</div>
      {!scheduleRequest && <details className="mt-1" open={moreOpen} onToggle={event => setMoreOpen(event.currentTarget.open)}>
        <summary className="min-h-11 cursor-pointer content-center text-sm font-medium text-primary">{t('More agents')}</summary>
        <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2 lg:grid-cols-3">{OTHER_TRIAL_CLIENTS.map(tile)}</div>
      </details>}
      {scheduleRequest && client.scheduleHelp && <p className="mt-2 text-sm text-muted-foreground">{t(client.scheduleHelp)}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-4">
        <Button type="button" variant="outline" className="min-h-11" aria-controls={id + '-setup'} aria-expanded={showSetup} onClick={() => setShowSetup(!showSetup)}>
          {interpolate(t('Set up {toolName}'), { toolName: name })}
        </Button>
        {client.open && <a className="inline-flex min-h-11 items-center gap-1 text-sm text-primary underline" href={client.open} target="_blank" rel="noopener noreferrer">
          {interpolate(t('Open {toolName}'), { toolName: name })}<ExternalLinkIcon aria-hidden="true" className="size-3.5" />
        </a>}
      </div>
      <div id={id + '-setup'} hidden={!showSetup} className="mt-2 rounded-lg border border-border bg-background p-3">
        <p className="break-words text-sm">{clientSetupInstructions(client, t)}</p>
        {client.availability && <p className="mt-1 text-xs text-muted-foreground">{t(client.availability)}</p>}
        {client.commands?.length ? client.commands.map((command, index) => field(command, index, true)) : field(CMEM_MCP_URL, 0, false)}
        {client.guide && <a className="inline-flex min-h-11 items-center gap-1 text-sm text-primary underline" href={client.guide} target="_blank" rel="noopener noreferrer">
          {t('Connection guide')}<ExternalLinkIcon aria-hidden="true" className="size-3.5" />
        </a>}
      </div>
      <label htmlFor={promptId} className="mt-2 block text-xs font-medium text-muted-foreground">{interpolate(t('Prompt for {toolName}'), { toolName: name })}</label>
      <textarea id={promptId} readOnly value={promptFor(client)} rows={3}
        className="mt-1 block min-h-24 w-full resize-y rounded-md border border-control-edge bg-background px-3 py-2 text-sm text-foreground" />
      <p role="status" className="mt-1 text-sm text-muted-foreground">{message}</p>
    </div>
  )
}
