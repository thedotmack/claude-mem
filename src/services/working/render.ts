// Per-prompt injection rendering for working memory. The block makes empty or
// stale state visible to the agent's eyes on every prompt — the structural
// defense against "forgot to write" (the slot limit alone only fires on
// overflow). Pure functions so the hook path stays trivially testable.
import type { WorkingEntry } from './store.js';

export interface WorkingRenderPayload {
  entries: WorkingEntry[];
}

/**
 * Reminder injected when the set is empty and the prompt is substantial — the
 * agent should have a hypothesis/plan recorded by now. Conditional phrasing:
 * the hook cannot know whether this session's toolset actually exposes the
 * working_* MCP tools, so the wording must not read as a command to call a
 * possibly-absent tool.
 */
export const WORKING_MEMORY_EMPTY_REMINDER =
  'Working memory is empty. If your toolset has working_set, record your current hypothesis/plan there.';

function formatTimeHHMM(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 16);
}

/**
 * Nudge appended to a task section with no intent entries. Intent absence is
 * the trigger (not set emptiness): the observer journal fills the set by
 * itself, so an emptiness-gated reminder never fires — sessions ran
 * journal-only Working Memory for hours (observed live).
 */
export const WORKING_MEMORY_NO_INTENT_NUDGE =
  '_No intent recorded — if your toolset has working_set, record your current hypothesis/plan._';

function renderTaskSection(taskKey: string, entries: WorkingEntry[]): string {
  const intents = entries
    .filter(entry => entry.kind === 'intent')
    .sort((a, b) => a.key.localeCompare(b.key));
  // Journal is a timeline: oldest first, newest last.
  const journal = entries
    .filter(entry => entry.kind === 'journal')
    .sort((a, b) => a.updated_at_epoch - b.updated_at_epoch || a.id - b.id);

  const lastUpdated = Math.max(...entries.map(entry => entry.updated_at_epoch));
  const lines = [`## Working Memory — task: ${taskKey} (updated ${formatTimeHHMM(lastUpdated)})`];
  for (const entry of intents) {
    lines.push(`- [intent] ${entry.key}: ${entry.value}`);
  }
  for (const entry of journal) {
    lines.push(`- [journal] ${entry.value}`);
  }
  // Per task, not per block: with the default cross-task render, one task
  // holding intent must not silence the nudge for a journal-only task —
  // that is the same "never fires" bug one level down.
  if (intents.length === 0) {
    lines.push('', WORKING_MEMORY_NO_INTENT_NUDGE);
  }
  return lines.join('\n');
}

/** Returns null when there is nothing live to show (caller injects the reminder). */
export function renderWorkingMemoryBlock(payload: WorkingRenderPayload): string | null {
  if (payload.entries.length === 0) return null;

  const byTask = new Map<string, WorkingEntry[]>();
  for (const entry of payload.entries) {
    const bucket = byTask.get(entry.task_key) ?? [];
    bucket.push(entry);
    byTask.set(entry.task_key, bucket);
  }

  return [...byTask.keys()]
    .sort()
    .map(taskKey => renderTaskSection(taskKey, byTask.get(taskKey)!))
    .join('\n\n');
}
