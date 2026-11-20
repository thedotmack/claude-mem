/**
 * How the Scan screen labels a found agent. Its prompts are read either way; one whose account cannot run setup
 * (installed, but signed out or refused) says so instead of a plain "detected".
 */
export function scanAgentStatus(agent: { canRunSetup: boolean | null; cannotRunReason: string | null }): { label: string; note: string | null } {
  if (agent.canRunSetup !== false) return { label: 'detected', note: null }
  return { label: "detected, can't run setup", note: agent.cannotRunReason }
}
