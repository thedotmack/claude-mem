// A request's stages: the finished work written up for review, one per format the worker lists. A stage is made only
// by its Generate click, or by the owner's opt-in to make one for every finished review. A ready stage opens as a
// plain-text file in a new tab; nothing here marks work checked.
import { useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Req } from '@/spec/req'
import type { Request } from '@/data'
import { useStore, useWorkModel } from '@/store'
import { offersStages } from '@/live/owner-runs-model'
import type { StageState } from '../../../../services/work-view/owner-runs.mjs'
import { ProductLink } from './bits'

const STAGE_STATE: Record<StageState, string> = { generating: 'Making…', ready: 'Ready', failed: 'Failed' }
const AUTO_STAGE_OFF = 'off'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Off by default. Choosing a format saves the setting and makes nothing by itself. */
function AutoStage() {
  const { t } = useI18n()
  const { stageFormats = [], autoStageFormat } = useWorkModel()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (autoStageFormat === undefined) return null
  const choose = async (value: string) => {
    setSaving(true)
    setError(null)
    try { await useStore.getState().setAutoStageFormat(value === AUTO_STAGE_OFF ? null : value) } catch (reason) { setError(messageOf(reason)) } finally { setSaving(false) }
  }
  return (
    <Req ids={['R20.4']}>
      <div className="space-y-1 pt-1 text-xs text-muted-foreground">
        <label className="flex flex-wrap items-center gap-2">
          {t('Stage every finished review automatically')}
          <Select value={autoStageFormat ?? AUTO_STAGE_OFF} onValueChange={(value) => void choose(value)} disabled={saving}>
            <SelectTrigger size="sm" aria-label={t('Stage every finished review automatically')} className="h-11 text-xs md:h-7"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO_STAGE_OFF}>{t('Off')}</SelectItem>
              {stageFormats.map((format) => <SelectItem key={format.id} value={format.id}>{t(format.label)}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <p>{t('Runs your agent once per finished review.')}</p>
        {error && <p role="alert" className="text-attention-foreground">{error}</p>}
      </div>
    </Req>
  )
}

export function RequestStages({ request }: { request: Request }) {
  const { t } = useI18n()
  const { stageFormats } = useWorkModel()
  const [starting, setStarting] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  if (!stageFormats?.length || !offersStages(request)) return null
  const generate = async (formatId: string) => {
    setStarting(formatId)
    setRefusal(null)
    try {
      const started = await useStore.getState().generateStage(request.id, formatId)
      if (started.outcome === 'refused') setRefusal(started.reason)
    } catch (error) { setRefusal(messageOf(error)) } finally { setStarting(null) }
  }
  return (
    <Req ids={['R20.3']}>
      <section className="space-y-2.5">
        <h4 className="section-label">{t('Stages')}</h4>
        <ul className="divide-y divide-border/70">
          {stageFormats.map((format) => {
            const stage = request.stages?.find((entry) => entry.formatId === format.id)
            return (
              <li key={format.id} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-0.5 py-1 text-sm">
                <span>{t(format.label)}</span>
                {stage && (
                  <span role="status" className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {stage.state === 'generating' && <Spinner className="size-3.5" />}
                    {t(STAGE_STATE[stage.state])}{stage.state === 'failed' && stage.error ? `: ${stage.error}` : ''}
                    {stage.outdated && <span className="text-attention-foreground">· {t('Made before the latest review')}</span>}
                  </span>
                )}
                <span className="ml-auto inline-flex items-center gap-2">
                  {stage?.state === 'ready' && <ProductLink href={stage.href} className="inline-flex min-h-11 items-center underline decoration-border underline-offset-4 hover:decoration-current md:min-h-7">{t('Open')}</ProductLink>}
                  {(!stage || stage.state === 'failed' || stage.outdated) && <Button variant="outline" size="sm" className="h-11 md:h-7" disabled={starting !== null} onClick={() => void generate(format.id)}>{t('Generate')}</Button>}
                </span>
              </li>
            )
          })}
        </ul>
        {refusal && <p role="alert" className="text-xs text-attention-foreground">{refusal}</p>}
        <AutoStage />
      </section>
    </Req>
  )
}
