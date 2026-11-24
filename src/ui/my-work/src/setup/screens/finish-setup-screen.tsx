import { ArrowRightIcon, CheckIcon, CopyIcon, ExternalLinkIcon, InfoIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { SaveButton } from '@/components/save-button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { interpolate, useI18n } from '@/lib/i18n'
import { CMEM_MCP_URL, type HistoryImportProgress, type SetupHistory, type SetupTool } from '../setup-data'
import type { HistoryImportStatus, MemoryBranch } from '../setup-flow'
import { PageHeading, PrivateWorkViewLink, SetupActions, SetupButton, SetupError, ToolMark, type SetupBack } from './shared'

function CopyUrl({ toolName }: { toolName: string }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<'' | 'URL copied.' | 'Select and copy the URL above.'>('')
  // Resolves false when the copy failed, so the button shows no check; the status line says what to do. The button says
  // what happens, a copy: Copying…, Copied, Not copied; nothing on this screen says Saving or Saved (nothing is saved).
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
        <SaveButton type="button" className="secondary" onClick={copy} aria-label={interpolate(t('Copy CMEM URL for {toolName}'), { toolName })}
          icon={<CopyIcon aria-hidden="true" />} savingLabel={t('Copying…')} savedLabel={t('Copied')} notSavedLabel={t('Not copied')}>{t('Copy URL')}</SaveButton>
      </div>
      <p className="connection-status" role="status" aria-live="polite">{t(status)}</p>
    </>
  )
}

/** On The Go: how each picked tool reads the cloud memory (PROTO renderConnectionDetails, CONNECTOR-EVIDENCE.md). */
function Connection({ tool, open }: { tool: SetupTool; open: boolean }) {
  const { t } = useI18n()
  return (
    <Collapsible className="connection" defaultOpen={open}>
      <CollapsibleFoldTrigger className="connection-trigger"><span className="connection-title"><ToolMark id={tool.id} name={tool.name} />{interpolate(t('{toolName} setup'), { toolName: tool.name })}</span></CollapsibleFoldTrigger>
      <CollapsibleContent className="connection-body">
        {tool.steps && <ol>{tool.steps.map((step) => <li key={step}>{t(step)}</li>)}</ol>}
        {tool.commands && <ol className="connection-commands">{tool.commands.map((command) => <li key={command}><code>{command}</code></li>)}</ol>}
        <CopyUrl toolName={tool.name} />
        {tool.guide && <a className="connection-guide" href={tool.guide.href} target="_blank" rel="noopener noreferrer">{t(tool.guide.label)}<ExternalLinkIcon aria-hidden="true" /></a>}
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * What the panel says about the last run, one entry per run state the page shows (setup-funnel.ts has the one list;
 * `idle`, no run yet, shows only the offer), so a new state fails the typecheck here until it has words. The English
 * text is the catalog key.
 */
const IMPORT_RUN_WORDS: Record<HistoryImportProgress['state'], string> = {
  // Seen here only after a reload while the worker still sends: Stop import beside it ends that run, and Import full
  // history shows its progress again.
  running: 'An import is already running.',
  stopped: 'You stopped the import.',
  // The import persists observations only (gap G2), so the receipt counts those and nothing else.
  done: '{count} memories imported to your CMEM account · Ready to search.',
  // Not the person's Stop: cmem.ai refused a batch, or a batch could not be sent.
  failed: 'The import couldn’t finish.',
}

/** Counts as the setup screens write them. */
const number = (value: number) => value.toLocaleString('en-US')

/**
 * A run the person stopped (E9): how far it got, what was on its way when they stopped, and how to go on. "Sent" counts
 * every memory cmem.ai answered for, including any it skipped because it already had them or could not read them, so
 * this line says sent, never that they all reached the account.
 */
function ImportStopped({ result }: { result: HistoryImportProgress }) {
  const { t } = useI18n()
  const unconfirmed = result.unconfirmed
  return (
    <div className="history-stopped" role="status">
      <p className="history-stopped-title">{t(IMPORT_RUN_WORDS.stopped)}</p>
      {result.sent !== undefined && result.total !== undefined && (
        <p className="tabular">{interpolate(t('{sent} of {total} memories were sent before you stopped.'), { sent: number(result.sent), total: number(result.total) })}</p>
      )}
      {unconfirmed !== undefined && (
        <p className="tabular">{unconfirmed === 1 ? t('1 more was on its way when you stopped. cmem.ai may have saved it.')
          : interpolate(t('{count} more were on their way when you stopped. cmem.ai may have saved some of them.'), { count: number(unconfirmed) })}</p>
      )}
      <p>{t('Nothing was deleted on this computer or in your account. Importing again skips memories already there.')}</p>
    </div>
  )
}

/**
 * What a finished run did. cmem.ai answers each batch with how many memories it wrote and how many it skipped, and it
 * skips both the ones it already has and the ones it cannot read without saying which (history-import.ts `skipped`),
 * so only the written ones are called added. A run that wrote every memory it sent says so in one line, as before E9.
 * A run that skipped some (Continue after a Stop sends the stopped run's memories again, and cmem.ai skips the ones it
 * has) says what it added and what the others were, so the person can tell their history is there.
 */
function ImportReceipt({ result }: { result: HistoryImportProgress | null }) {
  const { t } = useI18n()
  const imported = result?.imported ?? 0
  const skipped = result?.skipped ?? 0
  const sent = result?.sent
  if (!skipped || sent === undefined) return <p className="history-done tabular" role="status">{interpolate(t(IMPORT_RUN_WORDS.done), { count: number(imported) })}</p>
  return (
    <div className="history-done" role="status">
      <p className="tabular">{interpolate(t('This import added {imported} of {sent} memories to your CMEM account · Ready to search.'), { imported: number(imported), sent: number(sent) })}</p>
      <p className="history-done-rest tabular">{skipped === 1 ? t('The other 1 was already there, or cmem.ai couldn’t read it.')
        : interpolate(t('The other {count} were already there, or cmem.ai couldn’t read them.'), { count: number(skipped) })}</p>
    </div>
  )
}

function HistoryPanel({ history, status, result, stopping, onImport, onStop }: {
  history: SetupHistory; status: HistoryImportStatus; result: HistoryImportProgress | null
  /** A Stop sent from here (a run found running after a reload) is on its way. */
  stopping: boolean
  onImport: () => void; onStop: () => void
}) {
  const { t } = useI18n()
  const [permission, setPermission] = useState(false)
  return (
    <section className="panel is-memory history-panel" aria-labelledby="history-title">
      <h2 id="history-title">{t('Bring your existing memory')}</h2>
      <p>{t('Upload your existing claude-mem history from all projects to your CMEM account.')}</p>
      {status === 'complete' ? <ImportReceipt result={result} /> : (
        <>
          <p className="history-count tabular">{interpolate(t('{projects} projects · {sessions} sessions · {observations} memories'), { projects: history.projects, sessions: history.sessions, observations: number(history.observations) })}</p>
          {/* The last run, as the worker reports it. */}
          {result?.state === 'failed' && <SetupError title={t(IMPORT_RUN_WORDS.failed)} check={t('Import full history again to continue. Memories already in your CMEM account are skipped.')} detail={result.error} />}
          {result?.state === 'stopped' && <ImportStopped result={result} />}
          {/* A run found running (after a reload): Stop is right here, with no tick box; the box below is for a start. */}
          {result?.state === 'running' && (
            <div className="history-running">
              <p className="history-done" role="status">{t(IMPORT_RUN_WORDS.running)}</p>
              <SetupButton look="outline" busy={stopping} busyLabel={t('Stopping…')} onClick={onStop}>{t('Stop import')}</SetupButton>
            </div>
          )}
          {result?.state === 'done' && <ImportReceipt result={result} />}
          <label className="history-permission">
            <input type="checkbox" checked={permission} onChange={(event) => setPermission(event.target.checked)} />
            <span>{t('Import my full history from all projects to my CMEM account.')}</span>
          </label>
          <div className="history-actions">
            {/* Outlined: the screen's one navy button is Continue. Dimmed, it still reads at 4.5:1 and says what it waits for. */}
            <SetupButton look="outline" className="import-button" aria-disabled={!permission || undefined} aria-describedby={permission ? undefined : 'history-import-hint'} onClick={onImport}>{t('Import full history')}</SetupButton>
            {!permission && <p id="history-import-hint" className="setup-hint"><InfoIcon aria-hidden="true" />{t('Tick the box above to turn this on.')}</p>}
          </div>
        </>
      )}
    </section>
  )
}

/**
 * Step 6 (PROTO #route-finish-setup). Tools the install step connected are listed as connected; the others can be
 * added with a tick (E8). Detected tools come pre-ticked; the import panel shows only when there is history to import.
 */
export function FinishSetupScreen({ branch, tools, selected, onSelect, history, importStatus, importResult, stoppingImport, onImport, onStopImport, back, onContinue }: {
  branch: MemoryBranch
  tools: SetupTool[]
  selected: string[]
  onSelect: (selected: string[]) => void
  history: SetupHistory | null
  importStatus: HistoryImportStatus
  importResult: HistoryImportProgress | null
  /** The person pressed Stop import and the worker has not answered yet. */
  stoppingImport: boolean
  onImport: () => void
  /** Stops a run found running (after a reload), the same request as the import screen's Stop. */
  onStopImport: () => void
  /** Absent once the installer has applied the choice and there is no earlier screen left to change. */
  back?: SetupBack | null
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
  const connected = tools.filter((tool) => tool.installed)
  const addable = tools.filter((tool) => !tool.installed)
  const picked = addable.filter((tool) => selected.includes(tool.id))
  return (
    <section aria-labelledby="finish-setup-title">
      <PageHeading id="finish-setup-title" title={t('Connect your tools')} />
      {branch === 'go' && <PrivateWorkViewLink />}
      <form onSubmit={submit} noValidate>
        <div className={history ? 'finish-grid has-history' : 'finish-grid'}>
          <div className="panel finish-tools">
            <fieldset>
              <legend>{t('Use your memory in these tools')}</legend>
              {connected.length > 0 && <>
                <h3 className="finish-group">{t('Connected on this computer')}</h3>
                <ul className="tool-connected">
                  {connected.map((tool) => (
                    <li key={tool.id}><ToolMark id={tool.id} name={tool.name} /><span>{tool.name}<small className="tool-installed"><CheckIcon aria-hidden="true" />{t('Connected')}</small></span></li>
                  ))}
                </ul>
              </>}
              {addable.length > 0 && <>
                {connected.length > 0 && <h3 className="finish-group">{t('Add more')}</h3>}
                <div className="tool-options">
                  {addable.map((tool) => (
                    <label key={tool.id} className="tool-option">
                      <input type="checkbox" name="finish-tools" value={tool.id} checked={selected.includes(tool.id)} onChange={(event) => toggle(tool.id, event.target.checked)} />
                      <span className="tick" aria-hidden="true"><CheckIcon strokeWidth={3} /></span>
                      <ToolMark id={tool.id} name={tool.name} />
                      <span>{tool.name}</span>
                    </label>
                  ))}
                </div>
              </>}
            </fieldset>
            {showError && <p className="tool-error" role="alert">{t('Select at least one tool to continue.')}</p>}
            {branch === 'go' && picked.length > 0 && (
              <div className="connections" aria-label={t('Selected tool connections')}>
                {picked.map((tool, index, list) => <Connection key={tool.id} tool={tool} open={index === list.length - 1} />)}
              </div>
            )}
          </div>
          {history && <HistoryPanel history={history} status={importStatus} result={importResult} stopping={stoppingImport} onImport={onImport} onStop={onStopImport} />}
        </div>
        <SetupActions back={back}>
          <SetupButton type="submit">{t('Finish setup')} <ArrowRightIcon aria-hidden="true" /></SetupButton>
        </SetupActions>
      </form>
    </section>
  )
}
