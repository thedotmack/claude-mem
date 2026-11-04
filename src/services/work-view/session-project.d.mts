/** Types for session-project.mjs (the parts TypeScript callers use). */
export function projectRoot(project: unknown, gitRemoteNames?: boolean): string | null;
export function isAgentScratchFolder(folder: unknown): boolean;
export function repoRootOf(path: string): string | null;
