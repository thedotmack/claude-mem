import { ArrowRightIcon, CheckIcon, LoaderCircleIcon, SearchIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { interpolate, useI18n } from '@/lib/i18n'
import type { SetupInstallSelection, SetupInstallState, SetupInstallStatus } from '../../../../../shared/setup-install.ts'
import { PageHeading } from './shared'

const STATUS_LABELS: Record<SetupInstallStatus, string> = {
  waiting: 'Choose your agents and integrations',
  installing: 'Installing your agents and integrations…',
  ready: 'Your agents and integrations are ready.',
  failed: 'Installation needs another try.',
}

export function InstallScreen({ install, onInstall }: {
  install: SetupInstallState | null | undefined
  onInstall: (selection: SetupInstallSelection) => Promise<void>
}) {
  const { t } = useI18n()
  if (!install) return <section aria-labelledby="install-title"><PageHeading id="install-title" title={t('Set up claude-mem')} /><p className="install-loading" role="status"><LoaderCircleIcon aria-hidden="true" />{t('Loading your setup options…')}</p></section>
  if (install.status === 'installing' || install.status === 'ready') return (
    <section aria-labelledby="install-title">
      <PageHeading id="install-title" title={t(STATUS_LABELS[install.status])} lead={t('Keep this page open. Your memory setup starts next.')} />
      <div className="panel install-progress" role="status" aria-live="polite">
        <LoaderCircleIcon className="install-spinner" aria-hidden="true" />
        <p>{t('Connecting the tools you selected. This can take a minute.')}</p>
        <ul>{install.catalog.agents.filter(agent => install.selection?.agents.includes(agent.id)).map(agent => <li key={agent.id}><CheckIcon aria-hidden="true" />{agent.label}</li>)}</ul>
      </div>
    </section>
  )
  return <InstallOptions install={install} onInstall={onInstall} />
}

function InstallOptions({ install, onInstall }: { install: SetupInstallState; onInstall: (selection: SetupInstallSelection) => Promise<void> }) {
  const { t } = useI18n()
  const { catalog } = install
  const [selection, setSelection] = useState<SetupInstallSelection>(install.selection ?? catalog.defaults)
  const [query, setQuery] = useState('')
  const [emailOptIn, setEmailOptIn] = useState(Boolean(selection.email))
  const [reinstallConfirmed, setReinstallConfirmed] = useState(!catalog.reinstall)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const change = (patch: Partial<SetupInstallSelection>) => setSelection(current => ({ ...current, ...patch }))
  const toggleAgent = (id: string, checked: boolean) => change({ agents: checked ? [...selection.agents, id] : selection.agents.filter(agent => agent !== id) })
  const toggleSkill = (id: string, checked: boolean) => change({ skills: checked ? [...selection.skills, id] : selection.skills.filter(skill => skill !== id) })
  const agents = [...catalog.agents].sort((a, b) => Number(b.detected) - Number(a.detected)).filter(agent => `${agent.label} ${agent.hint ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  const claudeSelected = selection.agents.includes('claude-code')
  const claudeMissing = claudeSelected && !catalog.agents.find(agent => agent.id === 'claude-code')?.detected
  const models = [...new Set(['haiku', 'sonnet', 'opus', ...(catalog.defaults.claudeModel ? [catalog.defaults.claudeModel] : [])])]
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (sending || selection.agents.length === 0 || !reinstallConfirmed) return
    setSending(true)
    setError(null)
    try {
      await onInstall({ ...selection, installClaudeCode: claudeMissing && selection.installClaudeCode,
        ...(emailOptIn && catalog.emailEnabled !== false ? { email: selection.email?.trim(), note: selection.note?.trim() } : { email: undefined, note: undefined }) })
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setSending(false) }
  }
  return (
    <section aria-labelledby="install-title">
      <PageHeading id="install-title" title={t('Where do you work?')} lead={t('Choose your agents and integrations. We’ll connect them to your memory.')} />
      <form className="install-form" onSubmit={submit}>
        <fieldset className="panel install-agents" disabled={sending}>
          <legend className="sr-only">{t('Agents and integrations')}</legend>
          <div className="install-section-heading"><h2>{t('Agents and integrations')}</h2><span>{interpolate(t('{count} selected'), { count: selection.agents.length })}</span></div>
          <label className="install-search"><SearchIcon aria-hidden="true" /><span className="sr-only">{t('Find an agent or integration')}</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Find an agent or integration')} /></label>
          <div className="install-agent-options">
            {agents.map(agent => <label key={agent.id} className="install-agent">
              <input type="checkbox" name="install-agents" value={agent.id} checked={selection.agents.includes(agent.id)} onChange={event => toggleAgent(agent.id, event.target.checked)} />
              <span><strong>{agent.label}</strong>{agent.hint && <small>{t(agent.hint)}</small>}</span>
              {agent.detected && <span className="install-detected">{t('Detected')}</span>}
            </label>)}
          </div>
          {agents.length === 0 && <p className="install-help">{t('No matching agents or integrations.')}</p>}
          {selection.agents.length === 0 && <p className="tool-error">{t('Select at least one agent to continue.')}</p>}
          {claudeMissing && <label className="install-option install-host"><input type="checkbox" checked={selection.installClaudeCode} onChange={event => change({ installClaudeCode: event.target.checked })} /><span><strong>{t('Install Claude Code too')}</strong><small>{t('Claude Code wasn’t detected on this computer. You can also install it later.')}</small></span></label>}
          {selection.agents.includes('dsh') && <label className="install-model install-host"><span>{t('DeepSeek Harness profile')}</span><input type="text" value={selection.dshProfile ?? 'web'} onChange={event => change({ dshProfile: event.target.value })} placeholder="web" required maxLength={100} /><small>{t('The profile where claude-mem should be available.')}</small></label>}
        </fieldset>

        <details className="panel install-options">
          <summary>{t('Skills and preferences')}<span>{t('Optional')}</span></summary>
          <fieldset disabled={sending || catalog.skillsLocked}>
            <legend>{t('Bundled skills')}</legend>
            <p className="install-help">{t('Choose which claude-mem skills your agents can discover. You can change these later.')}</p>
            {catalog.skillsLocked && <p className="install-help">{t('Your environment controls skill selection.')}</p>}
            <div className="install-skill-actions"><button type="button" className="text-action" onClick={() => change({ skills: catalog.skills.map(skill => skill.id) })}>{t('Select all')}</button><button type="button" className="text-action" onClick={() => change({ skills: catalog.skills.filter(skill => skill.required).map(skill => skill.id) })}>{t('Only required skills')}</button></div>
            <div className="install-skill-options">{catalog.skills.map(skill => <label className="install-option" key={skill.id}><input type="checkbox" checked={skill.required || selection.skills.includes(skill.id)} disabled={skill.required || sending || catalog.skillsLocked} onChange={event => toggleSkill(skill.id, event.target.checked)} /><span><strong>{skill.label}{skill.required && <em>{t('Required')}</em>}</strong><small>{skill.description}</small></span></label>)}</div>
          </fieldset>
          <fieldset disabled={sending}>
            <legend>{t('Memory preferences')}</legend>
            <label className="install-model"><span>{t('Claude model')}</span><select value={selection.claudeModel ?? 'haiku'} onChange={event => change({ claudeModel: event.target.value })}>{models.map(model => <option key={model} value={model}>{model === 'haiku' ? t('Haiku — fast and economical') : model === 'sonnet' ? t('Sonnet — balanced') : model === 'opus' ? t('Opus — highest quality') : model}</option>)}</select><small>{t('Used if you choose your existing Claude plan for local memory.')}</small></label>
            {claudeSelected && <label className="install-option"><input type="checkbox" checked={selection.disableAutoMemory} onChange={event => change({ disableAutoMemory: event.target.checked })} /><span><strong>{t('Turn off Claude Code’s built-in auto-memory')}</strong><small>{t('Use claude-mem for cross-session memory. Leave unchecked to keep both.')}</small></span></label>}
            <label className="install-option"><input type="checkbox" checked={selection.telemetryEnabled} disabled={sending || catalog.telemetryLocked} onChange={event => change({ telemetryEnabled: event.target.checked })} /><span><strong>{t('Share anonymized usage data')}</strong><small>{t('Helps improve claude-mem. No prompts, code, or memory content are included.')}</small></span></label>
          </fieldset>
          {catalog.emailEnabled !== false && <fieldset disabled={sending}>
            <legend>{t('Product updates')}</legend>
            <label className="install-option"><input type="checkbox" checked={emailOptIn} onChange={event => setEmailOptIn(event.target.checked)} /><span><strong>{t('Email me product updates')}</strong><small>{t('Optional. You can unsubscribe at any time.')}</small></span></label>
            {emailOptIn && <div className="install-email"><label>{t('Email address')}<input type="email" autoComplete="email" required value={selection.email ?? ''} onChange={event => change({ email: event.target.value })} /></label><label>{t('Anything you’d like us to know?')}<textarea rows={2} maxLength={2000} value={selection.note ?? ''} onChange={event => change({ note: event.target.value })} /></label></div>}
          </fieldset>}
        </details>
        {catalog.reinstall && <label className="install-option install-reinstall"><input type="checkbox" checked={reinstallConfirmed} disabled={sending} onChange={event => setReinstallConfirmed(event.target.checked)} /><span>{t('Update my existing installation with these choices.')}</span></label>}
        {(error || install.error) && <p className="scan-error" role="alert">{error || install.error}</p>}
        <div className="actions"><button type="submit" className="primary" disabled={sending || !selection.agents.length || !reinstallConfirmed}>{sending ? t('Starting installation…') : install.status === 'failed' ? t('Try installation again') : t('Install and continue')}<ArrowRightIcon aria-hidden="true" /></button></div>
      </form>
    </section>
  )
}
