/**
 * Utility to find the Claude Code executable
 * Checks multiple common installation locations
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Find Claude Code executable by checking common installation locations
 * 
 * Priority order:
 * 1. CLAUDE_CODE_PATH environment variable (user override)
 * 2. 'claude' in system PATH
 * 3. Native installer location (~/.local/bin/claude)
 * 4. Global npm installation
 * 5. /usr/local/bin/claude
 * 6. /usr/bin/claude
 * 
 * @returns Path to Claude executable, or null if not found
 */
export function findClaudeExecutable(): string | null {
  // Priority 1: User-specified path via environment variable
  if (process.env.CLAUDE_CODE_PATH) {
    const customPath = process.env.CLAUDE_CODE_PATH;
    if (existsSync(customPath)) {
      return customPath;
    }
    // Log warning if custom path doesn't exist, but continue searching
    console.warn(`[claude-mem] CLAUDE_CODE_PATH is set but file not found: ${customPath}`);
  }

  // Priority 2: Check if 'claude' is in system PATH
  try {
    const whichResult = execSync('which claude', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    if (whichResult && existsSync(whichResult)) {
      return whichResult;
    }
  } catch (e) {
    // 'which' command failed or not available, continue
  }

  // Priority 3-6: Check common installation paths
  const commonPaths = [
    // Native installer location
    join(homedir(), '.local', 'bin', 'claude'),
    // Global npm installation
    (() => {
      try {
        const npmRoot = execSync('npm root -g', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        return join(npmRoot, '.bin', 'claude');
      } catch (e) {
        return null;
      }
    })(),
    // Standard Unix paths
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];

  for (const path of commonPaths) {
    if (path && existsSync(path)) {
      return path;
    }
  }

  return null;
}

/**
 * Get Claude Code executable path or throw error with helpful message
 * 
 * @returns Path to Claude executable
 * @throws Error if Claude executable not found
 */
export function getClaudeExecutable(): string {
  const claudePath = findClaudeExecutable();
  
  if (!claudePath) {
    throw new Error(
      'Claude Code executable not found. Please install Claude Code or set CLAUDE_CODE_PATH environment variable.\n' +
      'Common installation paths:\n' +
      '  - ~/.local/bin/claude (native installer)\n' +
      '  - /usr/local/bin/claude (global installation)\n' +
      '  - System PATH (npm global install)\n\n' +
      'To set custom path, add to ecosystem.config.cjs:\n' +
      '  env: {\n' +
      '    CLAUDE_CODE_PATH: "/path/to/claude"\n' +
      '  }'
    );
  }
  
  return claudePath;
}
