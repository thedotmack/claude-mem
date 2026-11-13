// A request's stages: the finished work written up for review, one per format the worker lists. A stage is made only
// by its Generate click, or by the owner's opt-in to make one for every finished review.
import { useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Req } from '@/spec/req'
import type { Request } from '@/data'
import { useStore, useWorkModel } from '@/store'
import type { StageState } from '../../../../services/work-view/owner-runs.mjs'
import { ProductLink } from './bits'
import { StageReader } from './stage-reader'
import { stageReading } from '@/live/stage-reader'

export const STAGE_STATE: Record<StageState, string> = { generating: 'Making…', ready: 'Ready', failed: 'Failed' }
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
    <Req ids={['R19.14']}>
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

/**
 * Generate, for the request page and the row: one click is one run (the store refuses a second click while the first
 * is starting, and the worker one while a stage is being made). `refusal` is why a run did not start, in the worker's words.
 * Resolves true when a run started.
 */
export function useStageGenerate(request: Pick<Request, 'id'>) {
  const [starting, setStarting] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const generate = async (formatId: string) => {
    setStarting(formatId)
    setRefusal(null)
    try {
      const started = await useStore.getState().generateStage(request.id, formatId)
      if (started.outcome === 'refused') setRefusal(started.reason)
      return started.outcome !== 'refused'
    } catch (error) { setRefusal(messageOf(error)); return false } finally { setStarting(null) }
  }
  return { starting, refusal, generate }
}

export function RequestStages({ request }: { request: Request }) {
  const { t } = useI18n()
  const { stageFormats } = useWorkModel()
  const { starting, refusal, generate } = useStageGenerate(request)
  const [reading, setReading] = useState<string | null>(null)
  if (!stageFormats?.length) return null
  return (
    <Req ids={['R19.13', 'R19.7']}>
      <div className="space-y-1">
        <ul>
          {stageFormats.map((format) => {
            const stage = request.stages?.find((entry) => entry.formatId === format.id)
            return (
              <li key={format.id} className="flex min-h-11 flex-wrap items-center gap-x-3 text-sm md:min-h-9">
                <span>{t(format.label)}</span>
                {stage && <span role="status" className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">{stage.state === 'generating' && <Spinner className="size-3.5" />}{t(STAGE_STATE[stage.state])}{stage.state === 'failed' && stage.error ? `: ${stage.error}` : ''}</span>}
                <span className="ml-auto">
                  {/* A ready stage is read here, in the page; one with nothing to read keeps its plain link. */}
                  {stage?.state === 'ready' && (stageReading(stage, stageFormats)
                    ? <button type="button" onClick={() => setReading(format.id)} className="inline-flex min-h-11 items-center rounded-sm underline decoration-border underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-ring md:min-h-7">{t('Open')}</button>
                    : <ProductLink href={stage.href} className="inline-flex min-h-11 items-center underline decoration-border underline-offset-4 hover:decoration-current md:min-h-7">{t('Open')}</ProductLink>)}
                  {(!stage || stage.state === 'failed' || stage.outdated) && <Button variant="outline" size="sm" className="h-11 md:h-7" disabled={starting !== null} onClick={() => void generate(format.id)}>{t('Generate')}</Button>}
                </span>
              </li>
            )
          })}
        </ul>
        {refusal && <p role="alert" className="text-xs text-attention-foreground">{refusal}</p>}
        <AutoStage />
        <StageReader request={request} formatId={reading} onClose={() => setReading(null)} />
      </div>
    </Req>
  )
}
