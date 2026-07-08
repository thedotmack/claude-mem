export type AgentSkipReason = 'subagent_observation' | 'agent_type_excluded';

export interface AgentSkipSettings {
  CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS?: unknown;
  CLAUDE_MEM_SKIP_AGENT_TYPES?: unknown;
}

export interface AgentSkipDecision {
  skip: boolean;
  reason?: AgentSkipReason;
}

const NO_SKIP: AgentSkipDecision = { skip: false };

export function parseSkipAgentTypes(raw: unknown): Set<string> {
  return new Set(
    String(raw ?? '')
      .split(',')
      .map(type => type.trim())
      .filter(Boolean)
  );
}

export function shouldSkipAgentObservation(
  agentId: string | undefined | null,
  agentType: string | undefined | null,
  settings: AgentSkipSettings,
): AgentSkipDecision {
  const skipSubagents = String(settings.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS ?? '').trim().toLowerCase() === 'true';
  if (skipSubagents && agentId) {
    return { skip: true, reason: 'subagent_observation' };
  }

  if (agentType && parseSkipAgentTypes(settings.CLAUDE_MEM_SKIP_AGENT_TYPES).has(agentType)) {
    return { skip: true, reason: 'agent_type_excluded' };
  }

  return NO_SKIP;
}
