import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, resolve } from 'path';
import { replaceTaggedContent } from './claude-md-utils.js';
import { logger } from './logger.js';

/**
 * Validate that a resolved path is within the user's home directory.
 * Prevents arbitrary file writes via user-configured paths (#1204).
 */
export function isPathWithinHomeDirectory(resolvedPath: string): boolean {
  const homeDir = homedir();
  return resolvedPath.startsWith(homeDir + '/') || resolvedPath.startsWith(homeDir + '\\') || resolvedPath === homeDir;
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

  // Reject paths outside the user's home directory (#1204)
  if (!isPathWithinHomeDirectory(resolvedPath)) {
    logger.warn('AGENTS_MD', 'Blocked write to path outside home directory', { agentsPath, resolvedPath });
    return;
  }

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
