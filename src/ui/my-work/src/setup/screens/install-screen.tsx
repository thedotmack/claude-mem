import { ArrowRightIcon, CheckIcon, InfoIcon, SearchIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { interpolate, useI18n } from '@/lib/i18n'
import { SETUP_DSH_PROFILE_MAX_CHARACTERS, type SetupInstallSelection, type SetupInstallState, type SetupInstallStatus } from '../../../../../shared/setup-install.ts'
import { toSetupFailure, type SetupFailure } from '../setup-data'
import { capText } from '../format'
import { CutNotice, PageHeading, SetupActions, SetupButton, SetupError } from './shared'

const STATUS_LABELS: Record<SetupInstallStatus, string> = {
  waiting: 'Choose your agents and integrations',
  installing: 'Installing your agents and integrations…',
  ready: 'Your agents and integrations are ready.',
  failed: 'Installation needs another try.',
}

/** The models the installer offers by name; anything else (a pinned id) shows as typed. */
const MODEL_NAMES: Partial<Record<string, string>> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

/**
 * The first screen. While installing it says what is happening; once ready it is shown again only when the person
 * goes Back from the scan to look at what was installed, and Continue returns them to the scan.
 */
export function InstallScreen({ install, onInstall, onContinue }: {
  install: SetupInstallState | null | undefined
  onInstall: (selection: SetupInstallSelection) => Promise<void>
  onContinue: () => void
}) {
  const { t } = useI18n()
  if (!install) return <section aria-labelledby="install-title"><PageHeading id="install-title" title={t('Set up claude-mem')} /><p className="install-loading" role="status"><Spinner />{t('Loading your setup options…')}</p></section>
  const chosen = install.catalog.agents.filter(agent => install.selection?.agents.includes(agent.id))
  if (install.status === 'installing') return (
    <section aria-labelledby="install-title">
      <PageHeading id="install-title" title={t(STATUS_LABELS.installing)} lead={t('Keep this page open. Your memory setup starts next.')} />
      <div className="panel install-progress" role="status" aria-live="polite">
        <Spinner className="install-spinner" />
        <p>{t('Connecting the tools you selected. This can take a minute.')}</p>
        <ul>{chosen.map(agent => <li key={agent.id}><CheckIcon aria-hidden="true" />{agent.label}</li>)}</ul>
      </div>
    </section>
  )
  if (install.status === 'ready') return (
    <section aria-labelledby="install-title">
      <PageHeading id="install-title" title={t(STATUS_LABELS.ready)} lead={t('These are the tools you chose. Continue to your memory scan.')} />
      <div className="panel install-ready">
        <ul aria-label={t('Agents and integrations')}>{chosen.map(agent => <li key={agent.id}><CheckIcon aria-hidden="true" />{agent.label}</li>)}</ul>
      </div>
      <SetupActions>
        <SetupButton onClick={onContinue}>{t('Continue')} <ArrowRightIcon aria-hidden="true" /></SetupButton>
      </SetupActions>
    </section>
  )
  return <InstallOptions install={install} onInstall={onInstall} />
}

function InstallOptions({ install, onInstall }: { install: SetupInstallState; onInstall: (selection: SetupInstallSelection) => Promise<void> }) {
  const { t } = useI18n()
  const { catalog } = install
  const [selection, setSelection] = useState<SetupInstallSelection>(install.selection ?? catalog.defaults)
  const [query, setQuery] = useState('')
  const [reinstallConfirmed, setReinstallConfirmed] = useState(!catalog.reinstall)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<SetupFailure | null>(null)
  const [profileCut, setProfileCut] = useState(false)
  const change = (patch: Partial<SetupInstallSelection>) => setSelection(current => ({ ...current, ...patch }))
  const toggleAgent = (id: string, checked: boolean) => change({ agents: checked ? [...selection.agents, id] : selection.agents.filter(agent => agent !== id) })
  const toggleSkill = (id: string, checked: boolean) => change({ skills: checked ? [...selection.skills, id] : selection.skills.filter(skill => skill !== id) })
  const agents = [...catalog.agents].sort((a, b) => Number(b.detected) - Number(a.detected)).filter(agent => `${agent.label} ${agent.hint ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  const claudeSelected = selection.agents.includes('claude-code')
  const claudeMissing = claudeSelected && !catalog.agents.find(agent => agent.id === 'claude-code')?.detected
  const models = [...new Set(['haiku', 'sonnet', 'opus', ...(catalog.defaults.claudeModel ? [catalog.defaults.claudeModel] : [])])]
  const noAgents = selection.agents.length === 0
  const waitingFor = noAgents ? 'install-agents-needed' : !reinstallConfirmed ? 'install-reinstall-hint' : undefined
  // The folded row says what is inside (E2): the skills agents can find, the model, and whether usage data is shared.
  const skillCount = catalog.skills.filter(skill => skill.required || selection.skills.includes(skill.id)).length
  const model = selection.claudeModel ?? 'haiku'
  const summary = [
    interpolate(skillCount === 1 ? t('{count} skill') : t('{count} skills'), { count: skillCount }),
    MODEL_NAMES[model] ?? model,
    selection.telemetryEnabled ? t('usage data shared') : t('usage data not shared'),
  ].join(' · ')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (sending || noAgents || !reinstallConfirmed) return
    setSending(true)
    setError(null)
    try {
      await onInstall({ ...selection, installClaudeCode: claudeMissing && selection.installClaudeCode })
    } catch (failure) { setError(toSetupFailure(failure)); setSending(false) }
  }
  return (
    <section aria-labelledby="install-title">
      {/* A failure takes the lead's place, so the screen still fits with its bottom row in view. */}
      <PageHeading id="install-title" title={t('Where do you work?')} lead={error || install.error ? undefined : t('Choose your agents and integrations. We’ll connect them to your memory.')} />
      {error ? <SetupError title={t('Couldn’t start the installation.')} failure={error} />
        : install.error && <SetupError title={t(STATUS_LABELS.failed)} check={t('Your choices are kept. Change anything you need, then try the installation again.')} detail={install.error} />}
      <form className="install-form" onSubmit={submit}>
        <fieldset className="panel install-agents" disabled={sending}>
          <legend className="sr-only">{t('Agents and integrations')}</legend>
          <div className="install-section-heading"><h2>{t('Agents and integrations')}</h2><span className="tabular">{interpolate(t('{count} selected'), { count: selection.agents.length })}</span></div>
          <label className="install-search-label" htmlFor="install-search">{t('Find an agent or integration')}</label>
          <div className="install-search"><SearchIcon aria-hidden="true" /><input id="install-search" type="search" value={query} onChange={event => setQuery(event.target.value)} /></div>
          <div className="install-agent-options">
            {agents.map(agent => <label key={agent.id} className="install-agent">
              <input type="checkbox" name="install-agents" value={agent.id} checked={selection.agents.includes(agent.id)} onChange={event => toggleAgent(agent.id, event.target.checked)} />
              <span className="install-agent-text"><strong>{agent.label}</strong>{agent.hint && <small>{t(agent.hint)}</small>}</span>
              {agent.detected && <span className="install-detected"><CheckIcon aria-hidden="true" />{t('Detected')}</span>}
            </label>)}
          </div>
          {agents.length === 0 && <p className="install-help">{t('No matching agents or integrations.')}</p>}
          {noAgents && <p id="install-agents-needed" className="tool-error">{t('Select at least one agent to continue.')}</p>}
          {claudeMissing && <label className="install-option install-host"><input type="checkbox" checked={selection.installClaudeCode} onChange={event => change({ installClaudeCode: event.target.checked })} /><span><strong>{t('Install Claude Code too')}</strong><small>{t('Claude Code wasn’t detected on this computer. You can also install it later.')}</small></span></label>}
          {selection.agents.includes('dsh') && <>
            <label className="install-model install-host"><span>{t('DeepSeek Harness profile')}</span><input type="text" value={selection.dshProfile ?? 'web'} aria-describedby={profileCut ? 'install-profile-cut' : undefined}
              onChange={event => { const capped = capText(event.target.value, SETUP_DSH_PROFILE_MAX_CHARACTERS); setProfileCut(capped.cut); change({ dshProfile: capped.text }) }} placeholder="web" required /><small>{t('The profile where claude-mem should be available.')}</small></label>
            {/* The worker's own limit (setup-install.ts): a longer paste is cut to it, and this line says so. */}
            {profileCut && <CutNotice id="install-profile-cut" max={SETUP_DSH_PROFILE_MAX_CHARACTERS} />}
          </>}
        </fieldset>

        <Collapsible className="panel install-options">
          <CollapsibleFoldTrigger count={summary}>{t('Skills and preferences')}</CollapsibleFoldTrigger>
          {/* Kept in the markup while folded, as the closed <details> did. */}
          <CollapsibleContent forceMount className="install-options-body">
            <fieldset disabled={sending || catalog.skillsLocked}>
              <legend>{t('Bundled skills')}</legend>
              <p className="install-help">{t('Choose which claude-mem skills your agents can discover. You can change these later.')}</p>
              {catalog.skillsLocked && <p className="install-help">{t('Your environment controls skill selection.')}</p>}
              <div className="install-skill-actions"><SetupButton look="text" onClick={() => change({ skills: catalog.skills.map(skill => skill.id) })}>{t('Select all')}</SetupButton><SetupButton look="text" onClick={() => change({ skills: catalog.skills.filter(skill => skill.required).map(skill => skill.id) })}>{t('Only required skills')}</SetupButton></div>
              <div className="install-skill-options">{catalog.skills.map(skill => <label className="install-option" key={skill.id}><input type="checkbox" checked={skill.required || selection.skills.includes(skill.id)} disabled={skill.required || sending || catalog.skillsLocked} onChange={event => toggleSkill(skill.id, event.target.checked)} /><span><strong>{skill.label}{skill.required && <em>{t('Required')}</em>}</strong><small>{skill.description}</small></span></label>)}</div>
            </fieldset>
            <fieldset disabled={sending}>
              <legend>{t('Memory preferences')}</legend>
              <label className="install-model"><span>{t('Claude model')}</span><select value={model} onChange={event => change({ claudeModel: event.target.value })}>{models.map(option => <option key={option} value={option}>{option === 'haiku' ? t('Haiku — fast and economical') : option === 'sonnet' ? t('Sonnet — balanced') : option === 'opus' ? t('Opus — highest quality') : option}</option>)}</select><small>{t('Used if you choose your existing Claude plan for local memory.')}</small></label>
              {claudeSelected && <label className="install-option"><input type="checkbox" checked={selection.disableAutoMemory} onChange={event => change({ disableAutoMemory: event.target.checked })} /><span><strong>{t('Turn off Claude Code’s built-in auto-memory')}</strong><small>{t('Use claude-mem for cross-session memory. Leave unchecked to keep both.')}</small></span></label>}
              <label className="install-option"><input type="checkbox" checked={selection.telemetryEnabled} disabled={sending || catalog.telemetryLocked} onChange={event => change({ telemetryEnabled: event.target.checked })} /><span><strong>{t('Share anonymized usage data')}</strong><small>{t('Helps improve claude-mem. No prompts, code, or memory content are included.')}</small></span></label>
            </fieldset>
          </CollapsibleContent>
        </Collapsible>
        {/* The first screen has no Back, so the reinstall choice that turns Install on sits on the row's left. */}
        <SetupActions start={catalog.reinstall && <>
          <label className="install-option install-reinstall"><input type="checkbox" checked={reinstallConfirmed} disabled={sending} onChange={event => setReinstallConfirmed(event.target.checked)} /><span>{t('Update my existing installation with these choices.')}</span></label>
          {!reinstallConfirmed && <p id="install-reinstall-hint" className="setup-hint"><InfoIcon aria-hidden="true" />{t('Tick this to turn on Install.')}</p>}
        </>}>
          <SetupButton type="submit" busy={sending} busyLabel={t('Starting installation…')} aria-disabled={waitingFor ? true : undefined} aria-describedby={waitingFor}>
            {install.status === 'failed' ? t('Try installation again') : t('Install and continue')}<ArrowRightIcon aria-hidden="true" />
          </SetupButton>
        </SetupActions>
      </form>
    </section>
  )
}
