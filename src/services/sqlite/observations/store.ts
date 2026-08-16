
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { logger } from '../../../utils/logger.js';

function getCurrentGitBranch(projectPath: string): string | null {
  try {
    const branch = execSync(`git -C "${projectPath}" rev-parse --abbrev-ref HEAD`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // Detached HEAD returns 'HEAD'
    return branch === 'HEAD' ? null : branch;
  } catch {
    // Not a git repo or git error
    return null;
  }
}

export function computeObservationContentHash(
  memorySessionId: string,
  title: string | null,
  narrative: string | null
): string {
  return createHash('sha256')
    .update([memorySessionId || '', title || '', narrative || ''].join('\x00'))
    .digest('hex')
    .slice(0, 16);
}
