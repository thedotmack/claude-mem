import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { replaceTaggedContent } from './claude-md-utils.js';
import { ensureDirectoryExists, resolveSymlinkWriteTarget } from '../shared/atomic-json.js';
import { logger } from './logger.js';

export function writeAgentsMd(agentsPath: string, context: string): void {
  if (!agentsPath) return;

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

  try {
    const writeTarget = resolveSymlinkWriteTarget(agentsPath);
    ensureDirectoryExists(dirname(writeTarget));
    const tempFile = `${writeTarget}.tmp`;
    writeFileSync(tempFile, finalContent);
    renameSync(tempFile, writeTarget);
  } catch (error: unknown) {
    logger.error('AGENTS_MD', 'Failed to write AGENTS.md', { agentsPath }, error instanceof Error ? error : new Error(String(error)));
  }
}
