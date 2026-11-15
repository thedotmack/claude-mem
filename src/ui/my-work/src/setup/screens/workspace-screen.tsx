import { ArrowRightIcon, SearchIcon } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { interpolate, useI18n } from '@/lib/i18n'
import { uiMessage, renderUiMessage, type UiMessage } from '../../../../ui-message'
import type { MemoryResult } from '../setup-data'
import { prefersReducedMotion } from '../format'

const formatDay = (day: string, locale: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })

/** `saved` is the text last written to memory, as observation `savedId`; an edit replaces that copy when the note loses focus. */
interface KeptNote { record: MemoryResult; text: string; saved: string; savedId: number }

function ResultCard({ record, note, onDiscard, onKeep, onEdit, onSave }: { record: MemoryResult; note?: KeptNote; onDiscard: () => void; onKeep?: () => void; onEdit?: (text: string) => void; onSave?: () => void }) {
  const { t, locale } = useI18n()
  const source = `${record.project} · ${record.agent} · ${record.session} · ${formatDay(record.date, locale === 'fr' ? locale : 'en-US')}`
  return (
    <article className="panel workspace-card" data-record-id={record.id}>
      <h2>{record.title}</h2>
      {note ? (
        <>
          <p className="source">{source}</p>
          <textarea value={note.text} maxLength={4000} aria-label={interpolate(t('Edit note: {title}'), { title: record.title })} onChange={(event) => onEdit?.(event.target.value)} onBlur={onSave} />
          <div className="footer"><div className="card-actions"><button type="button" className="text-action" onClick={onDiscard}>{t('Discard')}</button></div></div>
        </>
      ) : (
        <>
          <p className="body">{record.body}</p>
          <div className="footer">
            <p className="source">{source}</p>
            <div className="card-actions">
              <button type="button" className="text-action" onClick={onDiscard}>{t('Discard')}</button>
              <button type="button" className="secondary" onClick={onKeep}>{t('Keep as note')}</button>
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
export function WorkspaceScreen({ suggestions, search, keepNote, forgetNote, onContinue }: {
  suggestions: string[]; search: (query: string) => Promise<MemoryResult[]>; keepNote: (record: MemoryResult, text: string) => Promise<number>
  forgetNote: (id: number) => Promise<void>; onContinue: () => void
}) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MemoryResult[]>([])
  const [notes, setNotes] = useState<KeptNote[]>([])
  const [status, setStatus] = useState<UiMessage | string | null>(null)
  const searched = results.length > 0 || notes.length > 0

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
    if (!prefersReducedMotion()) formRef.current?.animate([{ opacity: 0, transform: 'scale(.18)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 650, easing: 'cubic-bezier(.22,.8,.2,1)' })
  }, [])

  const run = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) { inputRef.current?.focus(); return }
    setStatus(uiMessage('Searching your memory…'))
    let found: MemoryResult[]
    try { found = (await search(trimmed)).filter((record) => !notes.some((note) => note.record.id === record.id)) }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); return }
    setResults(found)
    setStatus(found.length === 0 ? uiMessage('No matching memories found.') : found.length === 1 ? uiMessage('1 memory found across your projects.') : uiMessage('{count} memories found across your projects.', { count: found.length }))
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void run(query) }
  const discard = (id: string) => { setResults((current) => current.filter((record) => record.id !== id)); setStatus(uiMessage('Removed from this view.')); inputRef.current?.focus() }
  // A kept note is a new memory; the result it came from is never changed.
  const save = async (record: MemoryResult, text: string, message: UiMessage): Promise<number | null> => {
    let id: number
    try { id = await keepNote(record, text) } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); return null }
    setStatus(message)
    return id
  }
  const keep = async (record: MemoryResult) => {
    const savedId = await save(record, record.body, uiMessage('Kept as a note in your memory.'))
    if (savedId === null) return
    setNotes((current) => [{ record, text: record.body, saved: record.body, savedId }, ...current])
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
    try { await forgetNote(note.savedId) } catch (error) {
      setStatus(uiMessage('Note saved, but its earlier copy is still in your memory: {error}', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  return (
    <section aria-labelledby="workspace-title" className={searched ? 'has-results' : undefined}>
      <div className="page-heading">
        <h1 id="workspace-title" tabIndex={-1}>{t('Hi, I remember stuff so you don’t have to.')}</h1>
        <p className="lead">{t('Everything you’ve done in Claude-Mem is right here at your fingertips.')}</p>
      </div>
      <form ref={formRef} className="workspace-search" onSubmit={submit}>
        {searched && <SearchIcon aria-hidden="true" className="size-7 shrink-0 text-[#5b5fd6]" />}
        <label className="sr-only" htmlFor="workspace-query">{t('Search your memory across projects')}</label>
        <input ref={inputRef} id="workspace-query" type="search" placeholder={t('What’s next?')} maxLength={200} autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />
        <span className="divider" aria-hidden="true" />
        <button className="primary" type="submit">{t('Search')} <ArrowRightIcon aria-hidden="true" /></button>
      </form>
      {!searched && suggestions.length > 0 && (
        <div className="query-options" aria-label={t('Search suggestions')}>
          {suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => { setQuery(suggestion); void run(suggestion) }}>{suggestion}</button>)}
        </div>
      )}
      <p className="workspace-status" role="status" aria-live="polite">{status === null ? t('Your projects, sessions and decisions. In one place.') : renderUiMessage(status, t)}</p>
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
                onEdit={(text) => setNotes((current) => current.map((entry) => entry.record.id === note.record.id ? { ...entry, text } : entry))}
                onSave={() => void saveEdit(note)}
                onDiscard={() => { setNotes((current) => current.filter((entry) => entry.record.id !== note.record.id)); setStatus(uiMessage('Note removed.')); inputRef.current?.focus() }} />
            ))}
          </div>
        </section>
      )}
      <div className="actions is-centered workspace-finish">
        <button type="button" className="primary" onClick={onContinue}>{t('Continue')} <ArrowRightIcon aria-hidden="true" /></button>
      </div>
    </section>
  )
}
