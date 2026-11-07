// Recorded agent stops. Claude Code's SubagentStop hook, and the owner's
// "Mark finished" action in My Work, each save one row to the "agent-lifecycle"
// work-state list. A row is evidence that an agent stopped at a known time; it
// is never inferred from how long an agent has been quiet. Rows are saved
// closed, so SessionStart work state never shows them.
export const AGENT_LIFECYCLE_LIST = 'agent-lifecycle';

export const isAgentLifecycleList = (name) => name === AGENT_LIFECYCLE_LIST;

export const STOP_SOURCES = ['subagent-stop-hook', 'owner-marked-finished'];

const stopKey = (platformSource, contentSessionId, agentId) => JSON.stringify([String(platformSource ?? 'claude'), String(contentSessionId), String(agentId)]);

/** The work-state fields for one recorded stop. */
export function agentStopFields({ platformSource, contentSessionId, agentId, agentType = null, stoppedAtEpoch, stopSource }) {
  if (!contentSessionId || !agentId) throw new Error('An agent stop needs the session and the agent id.');
  if (!STOP_SOURCES.includes(stopSource)) throw new Error(`Unknown agent stop source: ${stopSource}`);
  if (!Number.isFinite(stoppedAtEpoch) || stoppedAtEpoch <= 0) throw new Error('An agent stop needs the time it stopped.');
  return {
    task: `Agent ${agentId} in ${platformSource ?? 'claude'} session ${contentSessionId}`,
    status: 'done',
    platform_source: platformSource ?? 'claude',
    content_session_id: contentSessionId,
    agent_id: agentId,
    agent_type: agentType ?? null,
    stopped_at: new Date(stoppedAtEpoch).toISOString(),
    stopped_at_epoch: stoppedAtEpoch,
    stop_source: stopSource,
  };
}

/** The latest recorded stop per (platform, session, agent). */
export function readAgentStops(state) {
  const stops = new Map();
  for (const list of state.lists ?? []) {
    if (!isAgentLifecycleList(list.name)) continue;
    for (const task of list.tasks) {
      const { content_session_id: session, agent_id: agentId, platform_source: platform, stopped_at_epoch: at, stop_source: source } = task.fields;
      if (typeof session !== 'string' || typeof agentId !== 'string' || !Number.isFinite(at)) continue;
      const key = stopKey(platform, session, agentId);
      const current = stops.get(key);
      if (!current || at > current.stoppedAtEpoch) stops.set(key, { stoppedAtEpoch: at, source, entryId: task.latestEntryId });
    }
  }
  return stops;
}

export function agentStopFor(stops, platformSource, contentSessionId, agentId) {
  if (!contentSessionId || !agentId) return null;
  return stops.get(stopKey(platformSource, contentSessionId, agentId)) ?? null;
}
