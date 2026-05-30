// SPDX-License-Identifier: Apache-2.0

import { statSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const BYTES_PER_TOKEN = 3.5;

export function findTranscriptPath(sessionId: string): string | null {
  if (!sessionId) return null;
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const projectsDir = join(claudeConfigDir, 'projects');
  if (!existsSync(projectsDir)) return null;
  try {
    const entries = readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(projectsDir, entry.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

export function estimateContextFill(transcriptPath: string, contextWindowSize: number): number {
  try {
    const { size } = statSync(transcriptPath);
    return size / BYTES_PER_TOKEN / contextWindowSize;
  } catch {
    return 0;
  }
}
