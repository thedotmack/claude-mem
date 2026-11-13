import { ArrowRightIcon } from 'lucide-react'
import { AgentMark } from '@/components/brand'
import { formatPromptDay } from '@/lib/prompt-time'
import { interpolate, useI18n } from '@/lib/i18n'
import { agentToolFor, type RevealSets, type SetupExtraction, type SetupRecentPrompt, type SetupScanAgent } from '../setup-data'
import { promptStamp } from '../setup-reveal'
import { joinNames } from '../format'
import { PageHeading } from './shared'
import { FocusOverview } from '@/components/focus-overview'
import '@/components/focus-overview.css'

/** No logged-in agent yet: the prompts themselves, counted per agent and quoted as typed. The cards follow in My Work. */
function PromptsOnly({ agents, recentPrompts }: { agents: SetupScanAgent[]; recentPrompts: SetupRecentPrompt[] }) {
  const { t } = useI18n()
  return (
    <div className="reveal-sets">
      <section className="reveal-set is-landed" aria-labelledby="reveal-prompts">
        <h2 id="reveal-prompts">{t('Conversations')}</h2>
        <ol>
          {agents.map((agent) => (
            <li key={agent.id} className="reveal-card">
              <span className="lead-icon" aria-hidden="true"><AgentMark tool={agentToolFor(agent.id)} /></span>
              <div>
                <p className="title">{agent.label}</p>
                <p className="meta">{interpolate(t('{count} messages'), { count: agent.prompts.toLocaleString('en-US') })}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      {recentPrompts.length > 0 && (
        <section className="reveal-set is-landed" aria-labelledby="reveal-latest">
          <h2 id="reveal-latest">{t('Latest')}</h2>
          <ol>
            {recentPrompts.map((prompt) => (
              <li key={`${prompt.agent}-${prompt.at}`} className="reveal-card">
                <span className="lead-icon" aria-hidden="true">“</span>
                <div>
                  <p className="quote">“{prompt.text}”</p>
                  <p className="meta">{formatPromptDay(promptStamp(prompt.at))}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

/** The first payoff is the same saved focus areas as My Work. Areas and their work land independently. */
export function RevealScreen({ agents, reveal, extraction, uploadedAgents, recentPrompts, hostedNotice, onContinue }: {
  agents: SetupScanAgent[]; reveal: RevealSets; extraction: SetupExtraction | null; uploadedAgents: string[] | null; recentPrompts: SetupRecentPrompt[]; hostedNotice?: string | null; onContinue: () => void
}) {
  const { t, locale } = useI18n()
  // The results came only from the tools the person chose to upload.
  const withPrompts = agents.filter((agent) => agent.prompts > 0 && (!uploadedAgents || uploadedAgents.includes(agent.id)))
  const promptCount = withPrompts.reduce((sum, agent) => sum + agent.prompts, 0)
  // The person kept everything local and no earlier run left results: say that instead of promising knowledge that
  // was never built. This reads the recorded answer, because an upload can also come back with nothing to show.
  const hasResults = !!(reveal.focusAreas?.length || reveal.goals?.length || reveal.work?.length || reveal.rules?.length)
  const promptsOnly = extraction?.state === 'waiting-for-agent' && !hasResults
  const finished = extraction?.state === 'ok' || extraction?.state === 'failed'
  const keptLocal = uploadedAgents?.length === 0 && agents.some((agent) => agent.prompts > 0) && !hasResults
  if (keptLocal || (hostedNotice && !hasResults)) {
    return (
      <section aria-labelledby="reveal-title">
        <PageHeading id="reveal-title" title={t('Continue setup.')}
          lead={hostedNotice ? t(hostedNotice) : t('You skipped this step. Continue setting up Claude-Mem.')} />
        <div className="actions is-centered">
          <button type="button" className="primary" onClick={onContinue}>{t('Continue')} <ArrowRightIcon aria-hidden="true" /></button>
        </div>
      </section>
    )
  }
  const agentNames = withPrompts.map((agent) => agent.label)
  const agentsJoined = locale === 'zh-CN'
    ? (agentNames.length < 2 ? agentNames.join('') : `${agentNames.slice(0, -1).join('、')} 和 ${agentNames[agentNames.length - 1]}`)
    : locale === 'ko' || locale === 'fr' ? new Intl.ListFormat(locale, { type: 'conjunction' }).format(agentNames)
    : joinNames(agentNames)

  const leadText = promptCount > 0
    ? interpolate(t('From {count} messages across {agents}: the bigger picture of what you’re working toward.'), {
        count: promptCount.toLocaleString(locale === 'fr' ? locale : 'en-US'),
        agents: agentsJoined,
      })
    : undefined

  return (
    <section aria-labelledby="reveal-title">
      <PageHeading id="reveal-title" title={hostedNotice ? t('Continue setup.') : t('Your work is starting to connect.')}
        lead={hostedNotice ? undefined : leadText} />
      {hostedNotice && <p className="scan-status" role="status">{t(hostedNotice)}</p>}
      {extraction?.state === 'failed' && <p className="focus-reveal-notice" role="status">{t('Couldn’t finish connecting your work. You can continue with what’s here.')}</p>}
      {promptsOnly && <p className="focus-reveal-notice" role="status">{t('Your conversations are saved. Focus areas need an available agent; you can continue setup now.')}</p>}
      {promptsOnly ? <PromptsOnly agents={withPrompts} recentPrompts={recentPrompts} /> : <>
        <FocusOverview areas={reveal.focusAreas ?? []} requests={reveal.requests ?? []} discovering loading={reveal.focusAreas == null && !finished}
          workLoading={reveal.work === null && !finished} incomplete={(reveal.requestReadErrorCount ?? 0) > 0}
          emptyMessage={finished ? t(extraction?.state === 'failed' ? 'No focus areas were saved before this stopped. Continue setup to use your saved conversations.' : 'No focus areas found in this scan. You can continue setup and review your work later.') : undefined} />
        <details className="reveal-supporting">
          <summary>{t('What else came through')}</summary>
          <p>{t('A selection of requests and preferences from your conversations.')}</p>
          {(reveal.requestReadErrorCount ?? 0) > 0 && <p role="status">{t('Some requests could not be read. The work shown may be incomplete.')}</p>}
          {reveal.work?.map((work) => <p key={work.id}>{work.title}</p>)}
          {reveal.rules?.map((rule) => <blockquote key={rule.id}>{rule.text}<p>“{rule.quote}” · {formatPromptDay(rule.quotedAt)}</p></blockquote>)}
          {!reveal.focusAreas?.length && reveal.goals?.map((goal) => <p key={goal.id}>{goal.title}</p>)}
        </details>
      </>}
      <div className="actions is-centered focus-reveal-continue">
        <button type="button" className="primary" onClick={onContinue}>{t('Continue')} <ArrowRightIcon aria-hidden="true" /></button>
      </div>
    </section>
  )
}

