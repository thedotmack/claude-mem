// Per-thread "timeline pending" marker for Codex compactions.
//
// A Codex compaction replaces the thread's history, and the memory timeline
// claude-mem injected leaves with it. The PostCompact hook cannot emit
// additionalContext, so it only marks the thread here, and the timeline comes
// back through whichever context-capable hook reaches the thread first:
//   - SessionStart (source "compact"): Codex dispatches it to the root thread
//     after a compaction. The context hook re-injects the timeline and clears
//     the marker.
//   - PostToolUse: Codex never sends SessionStart to a subagent thread, so the
//     thread's next tool call takes the marker and returns the timeline as
//     additionalContext. A root thread whose SessionStart never reached
//     claude-mem gets it back the same way.
//
// Codex sends the root's session_id on every thread of an agent tree and names
// a subagent thread by agent_id (its own thread id), so a thread is the pair.
//
// Fail-open: a marker that cannot be read or removed means no re-injection, so a
// stuck marker can never repeat the timeline on every tool call.
import { sessionMarkerFiles } from './session-marker-files.js';

const pendingTimelineMarkers = sessionMarkerFiles('codex-compaction-pending', 'codex-compaction-gate');

function threadKey(sessionId: string, agentId: string | undefined): string {
  return agentId ? JSON.stringify([sessionId, agentId]) : sessionId;
}

export function markTimelinePending(sessionId: string, agentId: string | undefined): void {
  pendingTimelineMarkers.mark(threadKey(sessionId, agentId));
}

export function clearTimelinePending(sessionId: string, agentId: string | undefined): void {
  pendingTimelineMarkers.clear(threadKey(sessionId, agentId));
}

/** True for the one caller that removes the thread's marker, so one tool call re-injects. */
export function takeTimelinePending(sessionId: string, agentId: string | undefined): boolean {
  return pendingTimelineMarkers.take(threadKey(sessionId, agentId));
}
