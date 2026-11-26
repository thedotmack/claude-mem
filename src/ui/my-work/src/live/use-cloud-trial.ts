import { NO_VIEWER_TRIAL, viewerTrialStatus, type ViewerTrialStatus } from './cloud-trial-status'
import { nextTrialGuideStepAt } from './cloud-trial-guide'
import { useVisibleRefresh } from './use-visible-refresh'

async function readTrialStatus(signal: AbortSignal): Promise<ViewerTrialStatus> {
  const response = await fetch('/api/cloud-sync/renewal-status', { signal, cache: 'no-store' })
  return viewerTrialStatus(response.ok ? await response.json() : null, Date.now())
}

/** Read again at the next boundary the status names: the trial's end, the guide's end, or the guide's next step. */
function nextTrialCheckAt(status: ViewerTrialStatus, now: number): number | null {
  const boundaries = [
    status.trialEndsAt && Date.parse(status.trialEndsAt),
    status.onboarding && Date.parse(status.onboarding.endsAt),
    status.onboarding && nextTrialGuideStepAt(status.onboarding.startedAt, now),
  ].filter((at): at is number => typeof at === 'number' && at > now)
  return boundaries.length > 0 ? Math.min(...boundaries) : null
}

/**
 * One owner-scoped read serves both the billing notice and the guide. Local and sample work never read it. A read
 * that fails keeps the status already shown and tries again (useVisibleRefresh).
 */
export function useCloudTrial(isPrivateViewer: boolean): ViewerTrialStatus {
  return useVisibleRefresh(isPrivateViewer, readTrialStatus, nextTrialCheckAt) ?? NO_VIEWER_TRIAL
}
