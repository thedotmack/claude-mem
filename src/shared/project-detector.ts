/**
 * Robust Project Detector
 *
 * Detects the actual project from tool execution context,
 * handling cd commands, command chaining, absolute paths, etc.
 */

import { join, resolve, dirname, basename, sep } from 'path';
import { existsSync, statSync } from 'fs';
import { execSync } from 'child_process';

/**
 * Extract project name from a directory path
 * Finds git root or uses deepest meaningful directory name
 */
export function getProjectFromPath(dirPath: string): string | null {
  if (!dirPath || !existsSync(dirPath)) {
    return null;
  }

  // Resolve to absolute path
  const absPath = resolve(dirPath);

  // Try to find git root
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: absPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (gitRoot) {
      // Check if we're in a worktree - if so, use the main repo name
      try {
        const gitCommonDirRaw = execSync('git rev-parse --git-common-dir', {
          cwd: absPath,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim();

        // Resolve to absolute path to handle relative paths (e.g. "../.git")
        // and normalize comparison
        const gitCommonDir = resolve(absPath, gitCommonDirRaw);
        const expectedGitDir = resolve(gitRoot, '.git');

        // If git-common-dir points elsewhere, we're likely in a worktree
        // Note: checking absolute paths handles cases where we are in a subdir
        // but simple string comparison might fail due to symlinks (e.g. /var vs /private/var)
        // However, even if it fails due to symlinks, extracting the name from 
        // gitCommonDir usually yields the correct project name anyway.
        if (gitCommonDir !== expectedGitDir) {
          // Extract main repo name from common dir path
          // e.g., "/Users/me/git/universal-tracker/.git" → "universal-tracker"
          const mainRepoPath = dirname(gitCommonDir);
          return basename(mainRepoPath);
        }
      } catch {
        // Failed to get common dir, fall back to gitRoot
      }

      return basename(gitRoot);
    }
  } catch {
    // Not a git repo, continue
  }

  // Fallback: find meaningful directory name
  // Skip generic names like 'git', 'src', 'home', etc.
  const genericNames = new Set([
    'git', 'src', 'home', 'Users', 'var', 'tmp', 'opt',
    'usr', 'lib', 'bin', 'etc', 'dev', 'workspace', 'projects'
  ]);

  const parts = absPath.split(sep).filter(p => p && !genericNames.has(p));

  // Try to find a meaningful project name from path
  // Prefer directories that look like project names (contain letters, not just numbers)
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.match(/^[a-zA-Z]/) && part.length > 2) {
      return part;
    }
  }

  return parts[parts.length - 1] || null;
}

/**
 * Extract working directory from a Bash command
 * Handles cd, command chaining, and absolute paths
 */
export function extractDirFromBashCommand(command: string, currentCwd: string): string {
  if (!command) return currentCwd;

  // Handle cd commands (including chained ones)
  // Pattern: cd /some/path && ... OR cd /some/path; ... OR just cd /some/path
  const cdPatterns = [
    /cd\s+["']?([^"';&|]+?)["']?\s*(?:&&|;|\|\||$)/g,  // cd path && or cd path; or cd path (end)
    /cd\s+["']?([^"';&|\s]+)["']?/g,  // Simple cd path
  ];

  let lastCdPath: string | null = null;
  for (const pattern of cdPatterns) {
    let match;
    while ((match = pattern.exec(command)) !== null) {
      const cdPath = match[1].trim();
      if (cdPath && cdPath !== '-') {
        // Handle home directory expansion
        const expandedPath = cdPath.startsWith('~')
          ? cdPath.replace(/^~/, process.env.HOME || '')
          : cdPath;

        // Resolve relative to current cwd
        lastCdPath = expandedPath.startsWith('/')
          ? expandedPath
          : resolve(currentCwd || process.cwd(), expandedPath);
      }
    }
  }

  if (lastCdPath && existsSync(lastCdPath)) {
    return lastCdPath;
  }

  // Look for absolute paths in the command (file arguments)
  const absPathMatch = command.match(/(?:^|\s)(\/[^\s;&|"']+)/);
  if (absPathMatch) {
    const absPath = absPathMatch[1];
    // Check if it's a file or directory
    try {
      const stat = statSync(absPath);
      return stat.isDirectory() ? absPath : dirname(absPath);
    } catch {
      // Path doesn't exist, try parent
      const parent = dirname(absPath);
      if (existsSync(parent)) {
        return parent;
      }
    }
  }

  return currentCwd;
}

/**
 * Extract working directory from file tool input
 * (Read, Write, Edit, Glob, Grep)
 */
export function extractDirFromFileTool(toolInput: Record<string, any>): string | null {
  // Look for file_path, path, or similar fields
  const pathFields = ['file_path', 'path', 'filePath', 'directory', 'notebook_path'];

  for (const field of pathFields) {
    if (toolInput[field]) {
      const filePath = toolInput[field];
      try {
        const stat = statSync(filePath);
        return stat.isDirectory() ? filePath : dirname(filePath);
      } catch {
        // File might not exist yet, use parent
        const parent = dirname(filePath);
        if (existsSync(parent)) {
          return parent;
        }
      }
    }
  }

  return null;
}

export interface ToolContext {
  tool_name: string;
  tool_input: any;
  cwd: string;
}

/**
 * Detect the actual working directory from tool execution context
 * Handles cd commands, file paths, etc.
 *
 * @param tool_name - Name of the tool
 * @param tool_input - Tool input arguments
 * @param cwd - Current session CWD
 * @returns Detected CWD or original CWD if detection fails
 */
export function detectCwdFromTool(tool_name: string, tool_input: any, cwd: string): string {
  let detectedDir = cwd || process.cwd();

  // Handle different tool types
  switch (tool_name) {
    case 'Bash':
      const command = tool_input?.command || (typeof tool_input === 'string' ? tool_input : '');
      if (command) {
        const bashDir = extractDirFromBashCommand(command, cwd);
        if (bashDir) detectedDir = bashDir;
      }
      break;

    case 'Read':
    case 'Write':
    case 'Edit':
    case 'Glob':
    case 'Grep':
    case 'NotebookEdit':
      const fileDir = extractDirFromFileTool(tool_input || {});
      if (fileDir) detectedDir = fileDir;
      break;

    case 'Task':
      // For Task tool, try to extract from prompt if it mentions paths
      if (tool_input?.prompt) {
        const pathMatch = tool_input.prompt.match(/(?:^|\s)(\/[^\s"']+)/);
        if (pathMatch) {
          const taskPath = pathMatch[1];
          try {
            if (existsSync(taskPath)) {
              const stat = statSync(taskPath);
              detectedDir = stat.isDirectory() ? taskPath : dirname(taskPath);
            }
          } catch {}
        }
      }
      break;

    default:
      // Use session cwd for other tools
      break;
  }
  
  return detectedDir;
}

/**
 * Main function: detect project from tool execution context
 *
 * @param context - Tool execution context from PostToolUse hook
 * @returns Project name
 */
export function detectProjectFromTool(context: ToolContext): string {
  const { tool_name, tool_input, cwd } = context;
  
  const detectedDir = detectCwdFromTool(tool_name, tool_input, cwd);

  // Get project name from detected directory
  const project = getProjectFromPath(detectedDir);

  return project || 'unknown';
}
