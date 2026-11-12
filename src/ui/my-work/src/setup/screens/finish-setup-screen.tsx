import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, ChevronDownIcon, CopyIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { SaveButton } from '@/components/save-button'
import { interpolate, useI18n } from '@/lib/i18n'
import { CMEM_MCP_URL, type HistoryImportProgress, type SetupHistory, type SetupTool } from '../setup-data'
import type { HistoryImportStatus, MemoryBranch } from '../setup-flow'
import { PageHeading, ToolMark } from './shared'

function CopyUrl({ toolName }: { toolName: string }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<'' | 'URL copied.' | 'Select and copy the URL above.'>('')
  // Resolves false when the copy failed, so the button shows no check; the status line says what to do.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CMEM_MCP_URL)
      setStatus('URL copied.')
      return true
    } catch {
      setStatus('Select and copy the URL above.')
      return false
    }
  }
  return (
    <>
      <div className="connection-copy">
        <code>{CMEM_MCP_URL}</code>
        <SaveButton type="button" className="secondary" onClick={copy} aria-label={interpolate(t('Copy CMEM URL for {toolName}'), { toolName })}><CopyIcon aria-hidden="true" />{t('Copy URL')}</SaveButton>
      </div>
      <p className="connection-status" role="status" aria-live="polite">{t(status)}</p>
    </>
  )
}

/** On The Go: how each picked tool reads the cloud memory (PROTO renderConnectionDetails, CONNECTOR-EVIDENCE.md). */
function Connection({ tool, open }: { tool: SetupTool; open: boolean }) {
  const { t } = useI18n()
  return (
    <details className="connection" open={open}>
      <summary><ToolMark mark={tool.mark} />{interpolate(t('{toolName} setup'), { toolName: tool.name })}<ChevronDownIcon aria-hidden="true" /></summary>
      <div className="connection-body">
        {tool.steps && <ol>{tool.steps.map((step) => <li key={step}>{t(step)}</li>)}</ol>}
        {tool.commands && <ol className="connection-commands">{tool.commands.map((command) => <li key={command}><code>{command}</code></li>)}</ol>}
        <CopyUrl toolName={tool.name} />
        {tool.guide && <a href={tool.guide.href} target="_blank" rel="noopener noreferrer">{t(tool.guide.label)}</a>}
      </div>
    </details>
  )
}

function HistoryPanel({ history, status, result, onImport, onSkip }: { history: SetupHistory; status: HistoryImportStatus; result: HistoryImportProgress | null; onImport: () => void; onSkip: () => void }) {
  const { t } = useI18n()
  const [permission, setPermission] = useState(false)
  return (
    <section className="panel is-memory history-panel" aria-labelledby="history-title">
      <h2 id="history-title">{t('Bring your existing memory')}</h2>
      <p>{t('Upload your existing claude-mem history from all projects to your CMEM account.')}</p>
      {status === 'complete' ? (
        // The import persists observations only (gap G2), so the receipt counts those and nothing else.
        <p className="history-done" role="status">{interpolate(t('{count} memories imported to your CMEM account · Ready to search.'), { count: (result?.imported ?? 0).toLocaleString('en-US') })}</p>
      ) : (
        <>
          <p className="history-count">{interpolate(t('{projects} projects · {sessions} sessions · {observations} memories'), { projects: history.projects, sessions: history.sessions, observations: history.observations.toLocaleString('en-US') })}</p>
          {status === 'skipped' && <p className="history-done">{t('History import skipped. You can bring it over later.')}</p>}
          {result?.error && <p className="scan-error" role="alert">{result.error}</p>}
          <label className="history-permission">
            <input type="checkbox" checked={permission} onChange={(event) => setPermission(event.target.checked)} />
            <span>{t('Import my full history from all projects to my CMEM account.')}</span>
          </label>
          <div className="history-actions">
            <button type="button" className="import-button" disabled={!permission} onClick={onImport}>{t('Import full history')}</button>
            {status !== 'skipped' && <button type="button" className="text-action" onClick={onSkip}>{t('Skip import')}</button>}
          </div>
        </>
      )}
    </section>
  )
}

/** Step 6 (PROTO #route-finish-setup). Detected tools come pre-ticked; the import panel shows only when there is history to import. */
export function FinishSetupScreen({ branch, tools, selected, onSelect, history, importStatus, importResult, onImport, onSkipImport, onBack, onContinue }: {
  branch: MemoryBranch
  tools: SetupTool[]
  selected: string[]
  onSelect: (selected: string[]) => void
  history: SetupHistory | null
  importStatus: HistoryImportStatus
  importResult: HistoryImportProgress | null
  onImport: () => void
  onSkipImport: () => void
  /** Absent once the installer has applied the choice and there is no earlier screen left to change. */
  onBack?: () => void
  onContinue: () => void
}) {
  const { t } = useI18n()
  const [showError, setShowError] = useState(false)
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...selected, id] : selected.filter((entry) => entry !== id)
    onSelect(tools.map((tool) => tool.id).filter((toolId) => next.includes(toolId)))
    if (next.length) setShowError(false)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (selected.length === 0) {
      setShowError(true)
      document.querySelector<HTMLInputElement>('input[name="finish-tools"]')?.focus()
      return
    }
    onContinue()
  }
  const picked = tools.filter((tool) => selected.includes(tool.id))
  return (
    <section aria-labelledby="finish-setup-title">
      <PageHeading id="finish-setup-title" title={t('Finish Setup')} lead={t('Pick up any project without remembering where you left off.')} />
      <form onSubmit={submit} noValidate>
        <div className={history ? 'finish-grid has-history' : 'finish-grid'}>
          <div className="panel finish-tools">
            <fieldset>
              <legend>{t('Where do you want to use your memory?')}</legend>
              <div className="tool-options">
                {tools.map((tool) => (
                  <label key={tool.id} className="tool-option">
                    <input type="checkbox" name="finish-tools" value={tool.id} checked={selected.includes(tool.id)} disabled={tool.installed} onChange={(event) => toggle(tool.id, event.target.checked)} />
                    <ToolMark mark={tool.mark} />
                    <span>{tool.name}{tool.installed && <small className="tool-installed">{t('Connected')}</small>}</span>
                    <span className="tick" aria-hidden="true"><CheckIcon strokeWidth={3} /></span>
                  </label>
                ))}
              </div>
            </fieldset>
            {showError && <p className="tool-error" role="alert">{t('Select at least one tool to continue.')}</p>}
            {branch === 'go' && picked.some(tool => !tool.installed) && (
              <div className="connections" aria-label={t('Selected tool connections')}>
                {picked.filter(tool => !tool.installed).map((tool, index, list) => <Connection key={tool.id} tool={tool} open={index === list.length - 1} />)}
              </div>
            )}
          </div>
          {history && <HistoryPanel history={history} status={importStatus} result={importResult} onImport={onImport} onSkip={onSkipImport} />}
        </div>
        <div className="actions">
          {onBack && <button type="button" className="text-action" onClick={onBack}><ArrowLeftIcon aria-hidden="true" />{t('Back')}</button>}
          <button type="submit" className="primary">{t('Continue')} <ArrowRightIcon aria-hidden="true" /></button>
        </div>
      </form>
    </section>
  )
}
