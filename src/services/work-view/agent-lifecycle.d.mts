export const AGENT_LIFECYCLE_LIST: 'agent-lifecycle';
export function isAgentLifecycleList(name: unknown): boolean;
export type AgentStopSource = 'subagent-stop-hook' | 'owner-marked-finished';
export const STOP_SOURCES: AgentStopSource[];
export function agentStopFields(stop: {
  platformSource: string | null; contentSessionId: string; agentId: string; agentType?: string | null;
  stoppedAtEpoch: number; stopSource: AgentStopSource;
}): Record<string, string | number | null>;
export interface RecordedAgentStop { stoppedAtEpoch: number; source: AgentStopSource; entryId: number }
export function readAgentStops(state: unknown): Map<string, RecordedAgentStop>;
export function agentStopFor(stops: Map<string, RecordedAgentStop>, platformSource: string | null, contentSessionId: string | null, agentId: string | null): RecordedAgentStop | null;
