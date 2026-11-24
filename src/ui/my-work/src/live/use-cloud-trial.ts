import { useEffect, useState } from 'react'
import { NO_VIEWER_TRIAL, viewerTrialStatus } from '../../../../../services/viewer-host/src/cloud-trial'
import { nextTrialGuideStepAt } from './cloud-trial-guide'

/** One owner-scoped read serves both the billing notice and the guide. Local and sample work never read it. */
export function useCloudTrial(isPrivateViewer: boolean) {
  const [status, setStatus] = useState(NO_VIEWER_TRIAL)
  useEffect(() => {
    if (!isPrivateViewer) return
    let pending: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      if (document.visibilityState === 'hidden') return
      pending?.abort()
      clearTimeout(timer)
      const controller = new AbortController()
      pending = controller
      try {
        const response = await fetch('/api/viewer/cloud-sync-trial', { signal: controller.signal, cache: 'no-store' })
        const data = response.ok ? await response.json() : null
        if (controller.signal.aborted) return
        const now = Date.now()
        const next = viewerTrialStatus(data, now)
        setStatus(next)
        const boundaries = [
          next.trialEndsAt && Date.parse(next.trialEndsAt),
          next.onboarding && Date.parse(next.onboarding.endsAt),
          next.onboarding && nextTrialGuideStepAt(next.onboarding.startedAt, now),
        ].filter((at): at is number => typeof at === 'number' && at > now)
        if (boundaries.length > 0) timer = setTimeout(refresh, Math.min(Math.min(...boundaries) - now, 2_147_483_647))
      } catch {
        if (!controller.signal.aborted) setStatus(NO_VIEWER_TRIAL)
      }
    }
    void refresh()
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) void refresh() }
    window.addEventListener('pageshow', onPageShow)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      pending?.abort()
      clearTimeout(timer)
      window.removeEventListener('pageshow', onPageShow)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [isPrivateViewer])
  return isPrivateViewer ? status : NO_VIEWER_TRIAL
}
