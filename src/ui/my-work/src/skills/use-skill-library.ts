import { useCallback, useEffect, useRef, useState } from 'react'
import { registerSkillLeaveGuard } from '../live/skill-navigation'
import { changeDraft, newDraft, undoDraft, type EditKind, type SkillDraft } from './skill-draft'
import { SkillRequestError, type OpenSkill, type SkillEntry, type SkillListing, type SkillSource } from './skill-source'

interface Editor extends SkillDraft {
  entry: SkillEntry
  saved: boolean
  saving: boolean
  error: string | null
  conflict: OpenSkill | null
}

const editorFor = (document: OpenSkill): Editor => ({
  ...newDraft(document.text, document.revision), entry: document.entry,
  saved: false, saving: false, error: null, conflict: null,
})
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.'

export function useSkillLibrary(source: SkillSource) {
  const [listing, setListing] = useState<SkillListing | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [editors, setEditors] = useState<Record<string, Editor>>({})
  const listRequest = useRef(0)
  const openRequest = useRef(0)
  const savingIds = useRef(new Set<string>())

  const refresh = useCallback(async () => {
    const request = ++listRequest.current
    setRefreshing(true)
    setListError(null)
    try {
      const next = await source.list()
      if (request === listRequest.current) setListing(next)
    } catch (error) {
      if (request === listRequest.current) setListError(errorText(error))
    } finally {
      if (request === listRequest.current) setRefreshing(false)
    }
  }, [source])

  useEffect(() => {
    let mounted = true
    queueMicrotask(() => { if (mounted) void refresh() })
    window.addEventListener('focus', refresh)
    return () => {
      mounted = false
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  const dirty = Object.values(editors).some(editor => editor.text !== editor.baseText)
  useEffect(() => {
    if (!dirty) return
    const unregister = registerSkillLeaveGuard(() => window.confirm('Leave My Skills and discard unsaved edits?'))
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = true }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { unregister(); window.removeEventListener('beforeunload', beforeUnload) }
  }, [dirty])

  const update = (id: string, reduce: (draft: Editor) => Editor) =>
    setEditors(all => all[id] ? { ...all, [id]: reduce(all[id]) } : all)

  async function select(id: string | null) {
    const request = ++openRequest.current
    setSelected(id)
    setOpenError(null)
    // A dirty or in-flight draft belongs to its skill until Save or an explicit discard.
    const cached = id ? editors[id] : null
    if (!id || (cached && (cached.text !== cached.baseText || cached.saving))) {
      setOpening(false)
      return
    }
    setOpening(true)
    try {
      const doc = await source.open(id)
      if (request !== openRequest.current) return
      setEditors(all => {
        const previous = all[id]
        if (previous && (previous.text !== previous.baseText || previous.saving)) return all
        if (previous?.revision === doc.revision) return { ...all, [id]: { ...previous, entry: doc.entry } }
        return { ...all, [id]: editorFor(doc) }
      })
    } catch (error) {
      if (request === openRequest.current) setOpenError(errorText(error))
    } finally {
      if (request === openRequest.current) setOpening(false)
    }
  }

  const change = (id: string, next: string, kind: EditKind) =>
    update(id, draft => ({ ...draft, ...changeDraft(draft, next, kind), saved: false, error: null }))
  const undo = (id: string) =>
    update(id, draft => ({ ...draft, ...undoDraft(draft), saved: false, error: null }))
  const endTyping = (id: string) => update(id, draft => ({ ...draft, lastTypedAt: null }))

  async function save(id: string) {
    const draft = editors[id]
    if (!draft || savingIds.current.has(id) || !draft.entry.editable || draft.conflict || draft.text === draft.baseText) return
    savingIds.current.add(id)
    update(id, next => ({ ...next, saving: true, error: null, lastTypedAt: null }))
    try {
      const receipt = await source.save(id, draft.revision, draft.text)
      update(id, next => ({ ...next, entry: receipt.entry, revision: receipt.revision, baseText: draft.text, saved: true }))
      // An in-flight listing predating this save must not replace the receipt with stale metadata.
      listRequest.current++
      setRefreshing(false)
      setListing(list => list && { ...list, skills: list.skills.map(entry => entry.id === id ? receipt.entry : entry) })
    } catch (error) {
      if (error instanceof SkillRequestError && error.status === 409) {
        try {
          const latest = await source.open(id)
          update(id, next => ({ ...next, conflict: latest, error: null }))
        } catch (readError) { update(id, next => ({ ...next, error: 'Your draft is here. Could not read the newer version: ' + errorText(readError) })) }
      } else {
        update(id, next => ({ ...next, error: errorText(error) }))
      }
    } finally {
      savingIds.current.delete(id)
      update(id, next => ({ ...next, saving: false }))
    }
  }

  function resolveConflict(id: string, choice: 'use-latest' | 'keep-draft') {
    update(id, draft => {
      if (!draft.conflict) return draft
      if (choice === 'use-latest') return editorFor(draft.conflict)
      const latest = draft.conflict
      return { ...draft, entry: latest.entry, revision: latest.revision, baseText: latest.text, conflict: null, error: null, lastTypedAt: null }
    })
  }

  return { listing, listError, refreshing, refresh, selected, select, editors, opening, openError, change, undo, endTyping, save, resolveConflict }
}
