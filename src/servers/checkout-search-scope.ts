import type { ProjectContext } from '../utils/project-name.js';

/**
 * Extend an MCP search for the checkout's own project key to every key that
 * checkout reads (gate P2-5). The model only sees the current key, in the
 * SessionStart header, so `project` alone missed the memory the checkout
 * stored before a git-remote slug, an environment or a marker re-keyed it.
 * Searches for any other project, explicit `projects` lists and unscoped
 * searches pass through unchanged.
 */
export function withCheckoutProjects<T extends { project?: unknown; projects?: unknown }>(
  args: T,
  checkout: Pick<ProjectContext, 'primary' | 'allProjects'>
): T & { projects?: unknown } {
  if (args.projects !== undefined || typeof args.project !== 'string') return args;
  const project = args.project.trim();
  if (!project || project.toLowerCase() !== checkout.primary.toLowerCase() || checkout.allProjects.length < 2) {
    return args;
  }
  return { ...args, projects: checkout.allProjects.join(',') };
}
