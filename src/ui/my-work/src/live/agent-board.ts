// By agent's board (c-work-by-agent-view, page-02): which agents get a card and in what order, which subagents fold
// under which parent, and which requests have no agent. Pure, with .ts imports, so `node --test` loads it
// (pages/my-work.tsx ByAgentView draws it).
import { ATTENTION_ORDER, type Agent, type Request } from '../data.ts'
import { UNRECORDED_AGENT } from './to-work-model.ts'

/** An agent's card: the agent, its requests, its subagents nested under it (only where the data links them), and more. */
export interface AgentEntry {
  agent: Agent
  requests: Request[]
  /** Subagents linked to it (Agent.parentId), each with its requests. */
  subagents: { agent: Agent; requests: Request[] }[]
  /** Its requests and its subagents' together: the header's count. */
  total: number
  /** Its place in the model's list of agents, which settles every tie in the order. */
  order: number
}

/**
 * By agent's three parts. Their order is fixed, never the board's Sort, which By agent does not show:
 * - `withWork`: the agents with work in this view, busiest first: the most urgent request (ATTENTION_ORDER), then how
 *   many requests, then the model's own order, which also settles every tie;
 * - `unrecorded`: the requests with no agent recorded, and any that names an agent the model does not hold, so none is
 *   dropped;
 * - `idle`: the agents with nothing in this view, in the model's order, and `idleAgents`, how many agents that is with
 *   their subagents counted.
 * A subagent sits under its parent only where the model links them; otherwise it is a card of its own. Only a link to
 * an agent that stands on its own is followed (the mapper links a subagent to its session's main agent), so no chain
 * of links can hide a card. Each agent's requests keep the order they are given in (By agent passes them attention
 * first).
 */
export function agentBoard(agents: Agent[], requests: Request[]) {
  const ids = new Set(agents.map((agent) => agent.id))
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const requestsOf = (agentId: string) => requests.filter((request) => request.agentId === agentId)
  const linkedParent = (agent: Agent) => agent.parentId !== undefined && agent.parentId !== agent.id && ids.has(agent.parentId) ? agent.parentId : null
  const nestedUnder = (agent: Agent) => { const parent = linkedParent(agent); return parent !== null && linkedParent(byId.get(parent)!) === null ? parent : null }
  const cards = agents.filter((agent) => agent.id !== UNRECORDED_AGENT.id && nestedUnder(agent) === null)
  const entries: AgentEntry[] = cards.map((agent, order) => {
    const subagents = agents.filter((other) => nestedUnder(other) === agent.id).map((subagent) => ({ agent: subagent, requests: requestsOf(subagent.id) }))
    const own = requestsOf(agent.id)
    const total = own.length + subagents.reduce((sum, subagent) => sum + subagent.requests.length, 0)
    return { agent, requests: own, subagents, total, order }
  })
  const urgency = (entry: AgentEntry) => Math.min(ATTENTION_ORDER.length, ...[...entry.requests, ...entry.subagents.flatMap((subagent) => subagent.requests)].map((request) => ATTENTION_ORDER.indexOf(request.state)))
  const withWork = entries.filter((entry) => entry.total > 0).sort((a, b) => urgency(a) - urgency(b) || b.total - a.total || a.order - b.order)
  const idle = entries.filter((entry) => entry.total === 0)
  return {
    withWork,
    idle,
    idleAgents: idle.reduce((sum, entry) => sum + 1 + entry.subagents.length, 0),
    unrecorded: requests.filter((request) => request.agentId === UNRECORDED_AGENT.id || !ids.has(request.agentId)),
  }
}
