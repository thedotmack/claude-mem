// Per-prompt injection rendering for working memory. The block makes empty or
// stale state visible to the agent's eyes on every prompt — the structural
// defense against "forgot to write" (the slot limit alone only fires on
// overflow). Pure functions so the hook path stays trivially testable.
//
// The injection renders INTENT entries only. The observer journal stays in
// the DB and the /api/working response (debugging), but never enters the
// prompt — decided 2026-08-19 after live sessions showed a journal-only
// block reads as command spam: "Bash: python tools/dork.py …" says nothing
// about what was concluded or what is next, and working memory that is not
// small and meaningful is not working memory.
import type { WorkingEntry } from './store.js';

export interface WorkingRenderPayload {
  entries: WorkingEntry[];
}

/**
 * Reminder injected when there is nothing to render and the prompt is
 * substantial — the agent should have a hypothesis/plan recorded by now.
 * Conditional phrasing: the hook cannot know whether this session's toolset
 * actually exposes the working_* MCP tools, so the wording must not read as
 * a command to call a possibly-absent tool.
 */
export const WORKING_MEMORY_EMPTY_REMINDER =
  'Working memory is empty. If your toolset has working_set, record your current hypothesis/plan there.';

function formatTimeHHMM(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 16);
}

function renderTaskSection(taskKey: string, intents: WorkingEntry[]): string {
  const lastUpdated = Math.max(...intents.map(entry => entry.updated_at_epoch));
  const lines = [`## Working Memory — task: ${taskKey} (updated ${formatTimeHHMM(lastUpdated)})`];
  for (const entry of intents) {
    lines.push(`- [intent] ${entry.key}: ${entry.value}`);
  }
  return lines.join('\n');
}

/**
 * The rendered block, or null when there are no live INTENT entries — the
 * caller then injects the one-line reminder instead. Journal rows are
 * ignored here by design (see the file header).
 */
export function renderWorkingMemoryBlock(payload: WorkingRenderPayload): string | null {
  const intents = payload.entries.filter(entry => entry.kind === 'intent');
  if (intents.length === 0) return null;

  const byTask = new Map<string, WorkingEntry[]>();
  for (const entry of intents) {
    const bucket = byTask.get(entry.task_key) ?? [];
    bucket.push(entry);
    byTask.set(entry.task_key, bucket);
  }

  return [...byTask.keys()]
    .sort()
    .map(taskKey =>
      renderTaskSection(
        taskKey,
        byTask.get(taskKey)!.sort((a, b) => a.key.localeCompare(b.key)),
      ))
    .join('\n\n');
}
