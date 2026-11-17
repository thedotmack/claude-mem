// An agent's role and the machine it ran on, in the reader's language: the agent icon's identity (components/bits.tsx
// AgentIcon) and By agent's card headers (pages/my-work.tsx AgentCard) both word them here.
import { interpolate } from '@/lib/i18n'
import { isSubagent, type Agent, type Device } from '@/data'
import { agentOwnRole, RECORDED_SESSION_ROLE, THIS_COMPUTER } from '@/live/to-work-model'

/** "This computer" is the mapper's English name for the machine the page runs on; any other machine keeps its own name. */
export function deviceName(device: Device, t: (text: string) => string): string {
  return device.id === THIS_COMPUTER.id ? t(THIS_COMPUTER.name) : device.name
}

/**
 * An agent's own role in the reader's language (By agent's card header, which labels a subagent with its own badge):
 * the mapper's "Recorded session" through the catalog; a session title or folder name is the agent's and stays as
 * written.
 */
export function agentOwnRoleWords(agent: Pick<Agent, 'role' | 'status'>, t: (text: string) => string): string {
  const role = agentOwnRole(agent)
  return role === RECORDED_SESSION_ROLE ? t(RECORDED_SESSION_ROLE) : role
}

/**
 * An agent's role as its identity reads it (the agent icon's name and tooltip): a subagent's says so first, from the
 * typed field (data.ts isSubagent), never from the role's words.
 */
export function agentRoleWords(agent: Pick<Agent, 'role' | 'status'>, t: (text: string) => string): string {
  const role = agentOwnRoleWords(agent, t)
  return isSubagent(agent) ? interpolate(t('Subagent · {role}'), { role }) : role
}
