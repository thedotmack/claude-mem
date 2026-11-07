/**
 * The one definition of "this came from a subagent", shared by the SessionStart
 * injection filter (#3274) and the capture-side skip (#2736), so the read path
 * and the write path can never disagree about which rows are subagent rows.
 *
 * A subagent event carries BOTH an agent id and an agent type: Claude Code sends
 * both on every subagent hook. Either one alone is main-agent work:
 * - an agent id alone is what transcript-watch ingestion stamps on main-agent
 *   rows (a Grok Bot seat id, or the `<uuid>` of an `agent-transcripts/<uuid>/`
 *   path; see `resolveWatchAgentId`);
 * - an agent type alone is a main thread started with `claude --agent <type>`.
 */
export function isSubagentEvent(
  agentId: string | null | undefined,
  agentType: string | null | undefined
): boolean {
  return Boolean(agentId) && Boolean(agentType);
}

/**
 * SQL twin of {@link isSubagentEvent}: matches rows of `tableAlias` that did NOT
 * come from a subagent. Empty strings count as absent, exactly as in the
 * TypeScript check.
 */
export function mainAgentRowSql(tableAlias: string): string {
  return `(COALESCE(${tableAlias}.agent_id, '') = '' OR COALESCE(${tableAlias}.agent_type, '') = '')`;
}
