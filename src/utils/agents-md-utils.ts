import { writeTaggedBlock } from './context-injection.js';
import { logger } from './logger.js';

export function writeAgentsMd(agentsPath: string, context: string): void {
  if (!agentsPath) return;

  try {
    writeTaggedBlock(agentsPath, `# Memory Context\n\n${context}`);
  } catch (error: unknown) {
    logger.error('AGENTS_MD', 'Failed to write AGENTS.md', { agentsPath }, error instanceof Error ? error : new Error(String(error)));
  }
}
