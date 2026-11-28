import { existsSync, readFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { replaceTaggedContent } from './claude-md-utils.js';
import { writeTextFileAtomic } from '../shared/atomic-json.js';
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
    // writeTextFileAtomic resolves a symlinked AGENTS.md to its real target,
    // writes via a random exclusive-create temp file, fsyncs, and preserves
    // the file's mode. The random name matters: a predictable `${target}.tmp`
    // sibling can be planted inside a checkout as a symlink, and a following
    // write would then clobber whatever it points at. Failures are logged
    // rather than thrown, matching this writer's contract that an unwritable
    // target (e.g. a symlink loop) never breaks the caller's session.
    writeTextFileAtomic(agentsPath, finalContent);
  } catch (error: unknown) {
    logger.error('AGENTS_MD', 'Failed to write AGENTS.md', { agentsPath }, error instanceof Error ? error : new Error(String(error)));
  }
}
