// Sentences the worker's goals-and-progress refresh writes for people, which My Work's refresh line shows as they are,
// in the reader's language (components/bits.tsx RefreshStatus). Any other text the worker sends with a refresh is
// folded under "Details" below a plain line (decision G17), because it can be a raw error with a path or an id in it.
// No Node imports: My Work compiles this file too (docs/architecture/state-machines.md).

/**
 * Why POST /api/work-view/refresh did not start a refresh. The one definition: the route sends these
 * (src/services/worker/http/routes/WorkViewRoutes.ts startManualRefresh) and the refresh line shows them.
 */
export const REFRESH_START_REFUSAL = {
  unavailable: 'Refresh is unavailable on this worker.',
  setupRunning: 'Refresh is unavailable until setup finishes.',
  shuttingDown: 'This worker is shutting down.',
} as const

export type RefreshStartRefusal = (typeof REFRESH_START_REFUSAL)[keyof typeof REFRESH_START_REFUSAL]

const REFRESH_START_REFUSALS: readonly string[] = Object.values(REFRESH_START_REFUSAL)

/** Whether the worker's answer is one of its refusal sentences, which the refresh line shows as they are. */
export function isRefreshStartRefusal(text: string | null | undefined): text is RefreshStartRefusal {
  return typeof text === 'string' && REFRESH_START_REFUSALS.includes(text)
}

/**
 * Why a refresh waits for an agent: the agent runner's fixed sentences. The one definition: the runner, the only writer
 * of the `waiting-for-agent` state, returns them from here (src/services/agent-runner/run.ts runAgentTask), and the
 * refresh line shows them as they are. The two sentences it builds around an agent's or a setting's name stay in the
 * runner and are folded under Details.
 */
export const WAITING_FOR_AGENT_REASON = {
  noLoggedInAgent: 'No logged-in Claude Code, Codex or Gemini on this computer yet.',
  noAgentAllowed: 'No agent is allowed to run this task.',
} as const

export type WaitingForAgentReason = (typeof WAITING_FOR_AGENT_REASON)[keyof typeof WAITING_FOR_AGENT_REASON]

const WAITING_FOR_AGENT_REASONS: readonly string[] = Object.values(WAITING_FOR_AGENT_REASON)

/** Whether a waiting refresh's reason is one of the agent runner's fixed sentences, which the refresh line shows. */
export function isWaitingForAgentReason(text: string | null | undefined): text is WaitingForAgentReason {
  return typeof text === 'string' && WAITING_FOR_AGENT_REASONS.includes(text)
}
