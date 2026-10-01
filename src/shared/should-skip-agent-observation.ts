// Shared, pure decision helper for skipping subagent observations (issue #2736).
//
// Two filtering points call this with the SAME logic so behavior can't drift:
//   1. The PostToolUse hook handler (src/cli/handlers/observation.ts) — runs in
//      the short-lived hook process BEFORE any worker HTTP call or provider
//      request, so a skipped observation costs nothing. This covers both the
//      `worker` and `server` runtimes because it sits ahead of the runtime
//      branch.
//   2. The worker ingest path (src/services/worker/http/shared.ts) — defense in
//      depth for any caller that reaches the worker without going through the
//      hook handler (direct API callers, transcript-watch ingestion).
//
// Motivation: Claude Code Dynamic Workflows fan a single prompt out to
// tens-to-hundreds of parallel subagents (agent_type `workflow-subagent`), each
// tool call firing a PostToolUse hook → one provider-analyzed observation. A
// single run can emit hundreds-to-thousands of low-signal observations, which
// exhausts the configured provider's quota (HTTP 429) and trips the restart
// guard, dropping the rest of the run — including valuable main-session work.

import { isSubagentEvent } from './subagent-predicate.js';

export type AgentSkipReason = 'subagent_observation' | 'agent_type_excluded';

export interface AgentSkipSettings {
  /** When 'true', skip every subagent observation. */
  CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: string;
  /** Comma-separated subagent agent_type values to skip (e.g. "workflow-subagent,Explore"). */
  CLAUDE_MEM_SKIP_AGENT_TYPES: string;
}

export type AgentSkipDecision =
  | { skip: false }
  | { skip: true; reason: AgentSkipReason };

const NO_SKIP: AgentSkipDecision = { skip: false };

/** Parse a comma-separated agent_type skip list into a trimmed, de-duped set. */
export function parseSkipAgentTypes(raw: string | undefined | null): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)
  );
}

/**
 * Decide whether an observation should be skipped based on its agent context.
 *
 * Only a subagent event can be skipped, and a subagent event carries BOTH an
 * agent id and an agent type (see `isSubagentEvent`, shared with the
 * SessionStart injection filter). Either one alone is main-agent work: a
 * transcript-watch row (Grok Bot seat id) carries an agent id alone, and a
 * `claude --agent <type>` main thread carries an agent type alone. Neither knob
 * may drop those.
 *
 * Union semantics for subagent events:
 *   - CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS === 'true' → skip (the robust
 *     lever; independent of the exact type string).
 *   - Else agentType in CLAUDE_MEM_SKIP_AGENT_TYPES → skip (surgical).
 *
 * Defaults preserve current behavior: with the global toggle off and an empty
 * skip list, this never skips.
 */
export function shouldSkipAgentObservation(
  agentId: string | undefined | null,
  agentType: string | undefined | null,
  settings: AgentSkipSettings,
): AgentSkipDecision {
  if (!isSubagentEvent(agentId, agentType)) {
    return NO_SKIP;
  }

  if (settings.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS === 'true') {
    return { skip: true, reason: 'subagent_observation' };
  }

  if (agentType && parseSkipAgentTypes(settings.CLAUDE_MEM_SKIP_AGENT_TYPES).has(agentType)) {
    return { skip: true, reason: 'agent_type_excluded' };
  }

  return NO_SKIP;
}
