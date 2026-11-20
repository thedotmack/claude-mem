import { ArrowRightIcon, SearchIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { interpolate, useI18n } from '@/lib/i18n'
import { uiMessage, renderUiMessage, type UiMessage } from '../../../../ui-message'
import { toSetupFailure, type MemoryResult, type SetupFailure } from '../setup-data'
import { keptNoteText } from '../setup-search'
import { capText, prefersReducedMotion } from '../format'
import { CutNotice, SetupActions, SetupButton, SetupError, type SetupBack } from './shared'

const formatDay = (day: string, locale: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })

/**
 * The longest search the box sends. The words ride in the URL of GET /api/search, and the worker's HTTP server refuses
 * a request whose first line and headers pass 16 KiB (measured on Bun 1.3.9's node:http, the worker's server: a query
 * of 16,000 ASCII characters is answered, 16,300 gets 431). A letter can take 9 bytes in the URL (3 UTF-8 bytes,
 * percent-encoded), so 1,500 characters stay under 13.5 KB and leave room for the browser's headers. A longer paste is
 * cut to it, and the box says so.
 */
const SEARCH_QUERY_MAX_CHARACTERS = 1500

/**
 * `saved` is the text last written to memory, as observation `savedId`; an edit replaces that copy when the note loses
 * focus. `text` is always within the kept note's cap (setup-search.ts `keptNoteText`: the memory must stay one record
 * cloud sync takes), and `cut` says the box had to cut it, so the line under it says so.
 */
interface KeptNote { record: MemoryResult; text: string; saved: string; savedId: number; cut: boolean }

/** A failed search or save as the screen shows it: what failed (English, translated when drawn) and why. */
interface WorkspaceFailure { title: string; failure: SetupFailure }

function ResultCard({ record, note, onDiscard, onKeep, onEdit, onSave }: { record: MemoryResult; note?: KeptNote; onDiscard: () => void; onKeep?: () => void; onEdit?: (text: string) => void; onSave?: () => void }) {
  const { t, locale } = useI18n()
  const cutNoticeId = useId()
  const source = `${record.project} · ${record.agent} · ${record.session} · ${formatDay(record.date, locale === 'fr' ? locale : 'en-US')}`
  return (
    <article className="panel workspace-card" data-record-id={record.id}>
      <h2>{record.title}</h2>
      {note ? (
        <>
          <p className="source">{source}</p>
          <textarea value={note.text} aria-label={interpolate(t('Edit note: {title}'), { title: record.title })} aria-describedby={note.cut ? cutNoticeId : undefined}
            onChange={(event) => onEdit?.(event.target.value)} onBlur={onSave} />
          {/* The cap is in bytes (a character takes 1 to 6), so the line counts the characters that were kept. */}
          {note.cut && <CutNotice id={cutNoticeId} max={[...note.text].length} />}
          {/* Discard only takes the note off this page; the note stays saved in memory, so it is a plain action. */}
          <div className="footer"><div className="card-actions"><SetupButton look="text" onClick={onDiscard}>{t('Discard')}</SetupButton></div></div>
        </>
      ) : (
        <>
          <p className="body">{record.body}</p>
          <div className="footer">
            <p className="source">{source}</p>
            <div className="card-actions">
              <SetupButton look="text" onClick={onDiscard}>{t('Discard')}</SetupButton>
              <SetupButton look="outline" onClick={onKeep}>{t('Keep as note')}</SetupButton>
            </div>
          </div>
        </>
      )}
    </article>
  )
}

/**
 * Step 8, "What's next?" (PROTO #route-workspace, D7). Suggestion chips come from the person's own goals and open asks.
 * Results stack as cards: Discard hides one, Keep as note makes an editable copy; the source memory never changes.
 */
export function WorkspaceScreen({ suggestions, back, search, keepNote, forgetNote, onContinue }: {
  suggestions: string[]; back?: SetupBack | null; search: (query: string) => Promise<MemoryResult[]>; keepNote: (record: MemoryResult, text: string) => Promise<number>
  forgetNote: (id: number) => Promise<void>; onContinue: () => void
}) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const [query, setQuery] = useState('')
  const [queryCut, setQueryCut] = useState(false)
  const [results, setResults] = useState<MemoryResult[]>([])
  const [notes, setNotes] = useState<KeptNote[]>([])
  const [status, setStatus] = useState<UiMessage | null>(null)
  const [failure, setFailure] = useState<WorkspaceFailure | null>(null)
  const searched = results.length > 0 || notes.length > 0
  const report = (message: UiMessage) => { setStatus(message); setFailure(null) }
  const fail = (title: string, error: unknown) => { setStatus(null); setFailure({ title, failure: toSetupFailure(error) }) }

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
    if (!prefersReducedMotion()) formRef.current?.animate([{ opacity: 0, transform: 'scale(.18)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 650, easing: 'cubic-bezier(.22,.8,.2,1)' })
  }, [])

  const run = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) { inputRef.current?.focus(); return }
    report(uiMessage('Searching your memory…'))
    let found: MemoryResult[]
    try { found = (await search(trimmed)).filter((record) => !notes.some((note) => note.record.id === record.id)) }
    catch (error) { fail('Couldn’t search your memory.', error); return }
    setResults(found)
    report(found.length === 0 ? uiMessage('No matching memories found.') : found.length === 1 ? uiMessage('1 memory found across your projects.') : uiMessage('{count} memories found across your projects.', { count: found.length }))
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void run(query) }
  const discard = (id: string) => { setResults((current) => current.filter((record) => record.id !== id)); report(uiMessage('Removed from this view.')); inputRef.current?.focus() }
  // A kept note is a new memory; the result it came from is never changed.
  const save = async (record: MemoryResult, text: string, message: UiMessage): Promise<number | null> => {
    let id: number
    try { id = await keepNote(record, text) } catch (error) { fail('Couldn’t save the note.', error); return null }
    report(message)
    return id
  }
  const keep = async (record: MemoryResult) => {
    // The first copy is held to the same cap as an edit, so even a very long memory becomes a note that syncs.
    const first = keptNoteText(record, record.body)
    const savedId = await save(record, first.text, uiMessage('Kept as a note in your memory.'))
    if (savedId === null) return
    setNotes((current) => [{ record, text: first.text, saved: first.text, savedId, cut: first.cut }, ...current])
    setResults((current) => current.filter((entry) => entry.id !== record.id))
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-record-id="${record.id}"] textarea`)?.focus())
  }
  // The edited text is saved first, then the earlier copy is removed, so memory holds one copy of the note.
  const saveEdit = async (note: KeptNote) => {
    if (!note.text.trim() || note.text === note.saved) return
    const savedId = await save(note.record, note.text, uiMessage('Note saved.'))
    if (savedId === null) return
    setNotes((current) => current.map((entry) => entry.record.id === note.record.id ? { ...entry, saved: note.text, savedId } : entry))
    if (savedId === note.savedId) return
    try { await forgetNote(note.savedId) } catch (error) { fail('Note saved, but its earlier copy is still in your memory.', error) }
  }

  return (
    <section aria-labelledby="workspace-title" className={searched ? 'has-results' : undefined}>
      <div className="page-heading">
        <h1 id="workspace-title" tabIndex={-1}>{t('Hi, I remember stuff so you don’t have to.')}</h1>
        <p className="lead">{t('Everything you’ve done in Claude-Mem is right here at your fingertips.')}</p>
      </div>
      <form ref={formRef} className="workspace-search" onSubmit={submit}>
        <label className="workspace-label" htmlFor="workspace-query">{t('Search your memory across projects')}</label>
        <div className="workspace-field">
          <SearchIcon aria-hidden="true" />
          <input ref={inputRef} id="workspace-query" type="search" placeholder={t('What’s next?')} autoComplete="off" value={query} aria-describedby={queryCut ? 'workspace-query-cut' : undefined}
            onChange={(event) => { const capped = capText(event.target.value, SEARCH_QUERY_MAX_CHARACTERS); setQueryCut(capped.cut); setQuery(capped.text) }} />
          <SetupButton type="submit" look="outline">{t('Search')}</SetupButton>
        </div>
        {queryCut && <CutNotice id="workspace-query-cut" max={SEARCH_QUERY_MAX_CHARACTERS} />}
      </form>
      {!searched && suggestions.length > 0 && (
        <div className="query-options" aria-label={t('Search suggestions')}>
          {suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => { setQuery(suggestion); void run(suggestion) }}>{suggestion}</button>)}
        </div>
      )}
      <p className="workspace-status" role="status" aria-live="polite">{status === null ? t('Your projects, sessions and decisions. In one place.') : renderUiMessage(status, t)}</p>
      {failure && <SetupError title={t(failure.title)} failure={failure.failure} />}
      {results.length > 0 && (
        <div className="workspace-results" aria-label={t('Memory search results')}>
          {results.map((record) => <ResultCard key={record.id} record={record} onDiscard={() => discard(record.id)} onKeep={() => void keep(record)} />)}
        </div>
      )}
      {notes.length > 0 && (
        <section aria-labelledby="notes-title">
          <h2 id="notes-title" className="notes-title">{t('Kept notes')}</h2>
          <div className="kept-notes">
            {notes.map((note) => (
              <ResultCard key={note.record.id} record={note.record} note={note}
                onEdit={(text) => setNotes((current) => current.map((entry) => entry.record.id === note.record.id ? { ...entry, ...keptNoteText(entry.record, text) } : entry))}
                onSave={() => void saveEdit(note)}
                onDiscard={() => { setNotes((current) => current.filter((entry) => entry.record.id !== note.record.id)); report(uiMessage('Removed from this page. The note stays saved in your memory.')); inputRef.current?.focus() }} />
            ))}
          </div>
        </section>
      )}
      <SetupActions back={back} className="workspace-finish">
        <SetupButton onClick={onContinue}>{t('Open My Work')} <ArrowRightIcon aria-hidden="true" /></SetupButton>
      </SetupActions>
    </section>
  )
}
