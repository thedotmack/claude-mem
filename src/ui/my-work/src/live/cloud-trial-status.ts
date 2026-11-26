/** The only billing data read by My Work. Renewal is optional throughout an active trial. */
export interface TrialWindow { startedAt: string; endsAt: string }
export interface ViewerTrialStatus { trialEndsAt: string | null; onboarding: TrialWindow | null }
export const NO_VIEWER_TRIAL: ViewerTrialStatus = { trialEndsAt: null, onboarding: null };

const timestamp = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;

export function viewerTrialStatus(input: unknown, now = Date.now()): ViewerTrialStatus {
  if (!input || typeof input !== 'object') return NO_VIEWER_TRIAL;
  const data = input as { trialEndsAt?: unknown; onboarding?: { startedAt?: unknown; endsAt?: unknown } | null };
  const renewal = timestamp(data.trialEndsAt);
  const start = timestamp(data.onboarding?.startedAt);
  const end = timestamp(data.onboarding?.endsAt);
  return {
    trialEndsAt: renewal > now ? new Date(renewal).toISOString() : null,
    onboarding: start <= now && now < end ? { startedAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() } : null,
  };
}
