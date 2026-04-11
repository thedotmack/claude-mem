import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import { homedir } from 'os';
import { replaceTaggedContent } from './claude-md-utils.js';
import { logger } from './logger.js';

/**
 * Canonicalize a path using realpathSync to resolve symlinks.
 * Falls back to the input path if it doesn't exist yet (realpathSync requires the path to exist).
 */
function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Returns true if resolvedPath is safely within projectRoot or ~/.claude-mem/.
 * Prevents path traversal attacks (including symlink escapes) via watch.context.path in settings.
 */
export function isSafeContextPath(resolvedPath: string, projectRoot: string): boolean {
  const withSep = (p: string) => (p.endsWith(sep) ? p : p + sep);
  const canonicalPath = withSep(canonicalize(resolve(resolvedPath)));
  const projectPrefix = withSep(canonicalize(resolve(projectRoot)));
  const dataPrefix = withSep(canonicalize(resolve(homedir(), '.claude-mem')));
  return canonicalPath.startsWith(projectPrefix) || canonicalPath.startsWith(dataPrefix);
}

/**
 * Write AGENTS.md with claude-mem context, preserving user content outside tags.
 * Uses atomic write to prevent partial writes.
 */
export function writeAgentsMd(agentsPath: string, context: string): void {
  if (!agentsPath) return;

  // Never write inside .git directories — corrupts refs (#1165)
  const resolvedPath = resolve(agentsPath);
  if (resolvedPath.includes('/.git/') || resolvedPath.includes('\\.git\\') || resolvedPath.endsWith('/.git') || resolvedPath.endsWith('\\.git')) return;

  const dir = dirname(agentsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let existingContent = '';
  if (existsSync(agentsPath)) {
    existingContent = readFileSync(agentsPath, 'utf-8');
  }

  const contentBlock = `# Memory Context\n\n${context}`;
  const finalContent = replaceTaggedContent(existingContent, contentBlock);
  const tempFile = `${agentsPath}.tmp`;

  try {
    writeFileSync(tempFile, finalContent);
    renameSync(tempFile, agentsPath);
  } catch (error) {
    logger.error('AGENTS_MD', 'Failed to write AGENTS.md', { agentsPath }, error as Error);
  }
}
