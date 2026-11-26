import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReviewStackAction, ReviewStackSnapshot } from '../../../../shared/review-stack.ts'
import { readReviewStack, ReviewStackHttpError, sendReviewAction } from './review-stack-client'
import { localSource } from './local-source'

const errorText = (error: unknown) => error instanceof Error ? error.message : 'Could not reach Review Stack.'

export function useReviewStack(interacting: boolean) {
  const [snapshot, setSnapshot] = useState<ReviewStackSnapshot | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [stale, setStale] = useState(false)
  const currentRead = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const writing = useRef(false)
  const paused = useRef(interacting)
  const liveReadPending = useRef(false)
  const drainLiveRead = useRef<() => void>(() => {})
  const retries = useRef(new Map<string, string>())

  const refresh = useCallback(async (saved = false, live = false) => {
    currentRead.current?.abort()
    const controller = new AbortController()
    currentRead.current = controller
    const deadline = setTimeout(() => controller.abort(new Error('Loading Review Stack timed out.')), 45_000)
    try {
      const next = await readReviewStack(controller.signal)
      if (mounted.current && currentRead.current === controller) {
        if (live && (paused.current || document.hidden)) liveReadPending.current = true
        else {
          setSnapshot(previous => previous?.revision === next.revision ? previous : next)
          setStale(false); setError('')
        }
      }
      return next
    } catch (cause) {
      if (mounted.current && currentRead.current === controller) {
        setStale(true); setError((saved ? 'Saved. Reload to see the latest cards. ' : '') + errorText(cause))
      }
      return null
    } finally {
      clearTimeout(deadline)
      if (currentRead.current === controller) {
        currentRead.current = null
        drainLiveRead.current()
      }
    }
  }, [])
  useLayoutEffect(() => {
    paused.current = interacting
    if (!interacting) drainLiveRead.current()
  }, [interacting])
  useEffect(() => {
    mounted.current = true
    // Keep at most one read running. Remember hints received during a read, edit, gesture or hidden tab.
    drainLiveRead.current = () => {
      if (!liveReadPending.current || !mounted.current || currentRead.current || writing.current || paused.current || document.hidden) return
      liveReadPending.current = false
      void refresh(false, true)
    }
    const hint = () => { liveReadPending.current = true; drainLiveRead.current() }
    const visible = () => { if (!document.hidden) hint() }
    const unsubscribe = localSource.subscribeToReviewStackChanges?.(hint)
    hint()
    window.addEventListener('focus', visible); window.addEventListener('online', visible)
    document.addEventListener('visibilitychange', visible)
    return () => {
      mounted.current = false; unsubscribe?.(); drainLiveRead.current = () => {}
      currentRead.current?.abort(); currentRead.current = null
      window.removeEventListener('focus', visible); window.removeEventListener('online', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refresh])

  async function write(action: ReviewStackAction): Promise<{ saved: boolean; next: ReviewStackSnapshot | null; eventId?: string }> {
    if (writing.current || stale) return { saved: false, next: null }
    writing.current = true; setSaving(true); setError('')
    currentRead.current?.abort(); currentRead.current = null
    const identity = JSON.stringify(action)
    const key = retries.current.get(identity) ?? crypto.randomUUID()
    retries.current.set(identity, key)
    try {
      await sendReviewAction(action, key)
      retries.current.delete(identity)
      liveReadPending.current = false // this post-commit read already covers earlier hints
      return { saved: true, next: mounted.current ? await refresh(true) : null, eventId: key }
    } catch (cause) {
      if (cause instanceof ReviewStackHttpError && cause.status >= 400 && cause.status < 500) {
        retries.current.delete(identity)
        if (mounted.current && cause.status === 409) await refresh()
      }
      if (mounted.current) setError(errorText(cause))
      return { saved: false, next: null }
    } finally {
      writing.current = false
      if (mounted.current) { setSaving(false); drainLiveRead.current() }
    }
  }
  return { snapshot, error, saving, stale, refresh, write }
}
