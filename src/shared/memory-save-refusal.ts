/**
 * Why POST /api/memory/save refused a write. The worker then answers
 * `{ success: false, skipped: true, reason }` and stores nothing.
 *
 * The one definition (docs/architecture/state-machines.md):
 * src/services/worker/http/routes/MemoryRoutes.ts writes it. `claude-mem import`
 * (src/npx-cli/commands/import-memory.ts) and the MCP `save_memory` reply
 * (src/servers/mcp-text-format.ts) word it for people, each in a
 * `Record<MemorySaveRefusalReason, string>`.
 *
 * - project_excluded: the request's `cwd` matches CLAUDE_MEM_EXCLUDED_PROJECTS.
 */
export const MEMORY_SAVE_REFUSAL_REASONS = ['project_excluded'] as const;
export type MemorySaveRefusalReason = typeof MEMORY_SAVE_REFUSAL_REASONS[number];

export function isMemorySaveRefusalReason(value: unknown): value is MemorySaveRefusalReason {
  return typeof value === 'string' && (MEMORY_SAVE_REFUSAL_REASONS as readonly string[]).includes(value);
}
