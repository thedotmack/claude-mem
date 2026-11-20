/**
 * Bundled skills that claude-mem itself reads from the installed plugin at
 * runtime, so CLAUDE_MEM_SKILLS_DISABLED must never move them out of skills/.
 * Every runtime reader of plugin/skills/<name> takes its name from here.
 *
 * - mem-search: /api/instructions (Server.ts) and the Codex marketplace's
 *   required files (CodexCliInstaller.ts).
 * - how-it-works: the viewer's onboarding explainer (SearchRoutes.ts).
 * - request-progress, owner-goals: the My Work refresh (refresh-task.ts).
 *
 * No imports: the SessionStart hook bundle and the worker both load this.
 */
export const RUNTIME_SKILLS = {
  memSearch: 'mem-search',
  howItWorks: 'how-it-works',
  requestProgress: 'request-progress',
  ownerGoals: 'owner-goals',
} as const;

export const RUNTIME_REQUIRED_SKILLS: ReadonlySet<string> = new Set(Object.values(RUNTIME_SKILLS));
