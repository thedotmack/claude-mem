// The two decisions a person can save on a request, shared by the drawer and the thread list so both save the
// same way and say the same thing afterwards.
import { useState } from 'react'
import type { Request } from '@/data'
import { useStore, useWorkModel } from '@/store'
import { CHANGED_WHILE_READING_MESSAGE, CHECK_UNDONE_MESSAGE, CHECKED_LOCALLY_MESSAGE, type ReviewResult } from '@/live/review-response'

export type SaveNotice = { tone: 'saved' | 'problem'; message: string }

/** What the person is told after the worker answers (app.js `saveReview` toasts). */
function noticeFor(result: ReviewResult, checked: boolean, requestId: string, expectedFingerprint?: string): SaveNotice {
  switch (result.outcome) {
    case 'saved': {
      const latest = result.model.requests.find((request) => request.id === requestId)
      const review = latest?.review
      const shared = (result.save?.scope ?? review?.mode) === 'shared'
      const pending = result.save ? result.save.state === 'queued' : review?.pending
      if (shared && review?.conflict) return {
        tone: 'problem', message: `Your review decision was saved here, but your viewers still have conflicting decisions. Read this version and choose again.${pending ? ' The saved decision is waiting to sync.' : ''}`,
      }
      if (expectedFingerprint && latest?.contentFingerprint !== expectedFingerprint) return {
        tone: 'problem', message: `Your review decision was saved for the version you read. The current work changed; review it again.${shared && pending ? ' The saved decision is waiting to sync.' : ''}`,
      }
      return { tone: 'saved', message: shared
        ? `${checked ? 'Checked' : 'Check undone'} for this shared version.${pending ? ' Saved here; waiting to sync to your other viewers.' : ''}`
        : result.model.sourceKind === 'cloud'
          ? `${checked ? 'Checked' : 'Check undone'} in your cloud viewer only. My Work sharing is off.`
          : checked ? CHECKED_LOCALLY_MESSAGE : CHECK_UNDONE_MESSAGE }
    }
    case 'changed-while-reading': return { tone: 'problem', message: result.serverMessage ?? CHANGED_WHILE_READING_MESSAGE }
    case 'refused': return { tone: 'problem', message: result.serverMessage }
    case 'unavailable': return { tone: 'problem', message: result.serverMessage }
  }
}

/**
 * Marks the version on screen checked, or undoes it. `save` resolves false when nothing was saved; `notice` says why.
 * `version` is for a screen that shows an earlier reading of the request (the stage reader): the check is then for
 * that version, and the worker refuses it once the request has moved on.
 */
export function useCheckSave(request: Request, version?: { fingerprint: string | undefined; reviewHash: string | null | undefined }) {
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<SaveNotice | null>(null)
  const save = async (checked: boolean) => {
    setSaving(true)
    let next: SaveNotice
    try {
      // The version on screen is the one checked; the worker refuses any other.
      const { fingerprint, reviewHash } = version ?? { fingerprint: request.contentFingerprint, reviewHash: request.review?.hash }
      next = noticeFor(await useStore.getState().setRequestChecked(request.id, checked, fingerprint, reviewHash), checked, request.id, fingerprint)
    } catch (error) {
      next = { tone: 'problem', message: error instanceof Error ? error.message : String(error) }
    } finally {
      setSaving(false)
    }
    setNotice(next)
    return next.tone !== 'problem'
  }
  return { saving, notice, save }
}

/** Answers "is this part of another request?": join it, or keep the two apart. */
export function useSuggestionSave(suggestion: Request['suggestion']) {
  const { sourceKind } = useWorkModel()
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<SaveNotice | null>(null)
  const save = async (action: 'join' | 'not-this') => {
    if (!suggestion) return
    setSaving(true)
    try {
      const result = await useStore.getState().answerRequestSuggestion(suggestion, action)
      const shared = result.save?.scope === 'shared'
      const localCopy = result.save?.localMaterialization === 'pending' ? " This viewer's local work copy is still updating." : ''
      const conflict = result.model.requests.some((current) => current.suggestion?.conversationKey === suggestion.conversationKey && current.suggestion.sharedConflict)
      if (conflict) {
        setNotice({ tone: 'problem', message: `Your decision was saved here, but grouping decisions still conflict. Read this suggestion and choose again.${shared && result.save?.state === 'queued' ? ' The saved decision is waiting to sync.' : ''}${localCopy}` })
        return
      }
      setNotice({ tone: 'saved', message: `${action === 'join' ? 'Joined the request.' : 'Kept these requests separate.'} ${shared
        ? result.save?.state === 'queued' ? 'Saved here; waiting to sync to your other viewers.' : 'Saved as a shared decision.'
        : sourceKind === 'cloud' ? 'Saved in your cloud viewer only.' : 'Saved on this machine only.'}${localCopy}` })
    } catch (error) { setNotice({ tone: 'problem', message: error instanceof Error ? error.message : String(error) }) }
    finally { setSaving(false) }
  }
  return { saving, notice, save }
}
