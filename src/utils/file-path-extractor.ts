/**
 * File Path Extractor — extracts file paths from Claude Code tool inputs/responses.
 *
 * Used by hub mode to determine which project a tool operation belongs to
 * by analyzing the file paths it touches.
 */

/**
 * Extract file paths from a tool's input and response.
 *
 * Supports:
 * - Read/Write/Edit: file_path parameter
 * - NotebookEdit: notebook_path parameter
 * - Glob: path + pattern (returns the search directory)
 * - Grep: path parameter
 * - Bash: extracts paths from common file commands in the command string
 *
 * @returns Array of file paths found (may be empty)
 */
export function extractFilePathsFromTool(
  toolName: string,
  toolInput: Record<string, unknown> | string | null | undefined,
  toolResponse: Record<string, unknown> | string | null | undefined
): string[] {
  if (!toolInput) return [];

  const input = typeof toolInput === 'string' ? safeParse(toolInput) : toolInput;
  if (!input) return [];

  const paths: string[] = [];

  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      addIfString(paths, input.file_path);
      break;

    case 'NotebookEdit':
    case 'NotebookRead':
      addIfString(paths, input.notebook_path);
      break;

    case 'Glob':
      addIfString(paths, input.path);
      break;

    case 'Grep':
      addIfString(paths, input.path);
      break;

    case 'Bash': {
      const command = typeof input.command === 'string' ? input.command : null;
      if (command) {
        extractPathsFromBashCommand(paths, command);
      }
      break;
    }

    case 'Agent':
      // Agents may reference files in their prompts — not extractable
      break;

    default:
      // Unknown tool — try common field names
      addIfString(paths, input.file_path);
      addIfString(paths, input.path);
      addIfString(paths, input.notebook_path);
      break;
  }

  // Also extract from tool response if it contains file paths
  if (toolResponse) {
    const response = typeof toolResponse === 'string' ? safeParse(toolResponse) : toolResponse;
    if (response) {
      // Some tools return the file path in the response
      addIfString(paths, response.file_path);
      addIfString(paths, response.path);
    }
  }

  // Deduplicate and filter out empty/invalid paths
  return [...new Set(paths.filter(p => p.length > 0))];
}

function addIfString(paths: string[], value: unknown): void {
  if (typeof value === 'string' && value.trim().length > 0) {
    paths.push(value.trim());
  }
}

function safeParse(str: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(str);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Extract file paths from a bash command string.
 * Looks for common patterns like:
 * - cd /path/to/dir
 * - cat /path/to/file
 * - vim /path/to/file
 * - Paths after common flags
 */
function extractPathsFromBashCommand(paths: string[], command: string): void {
  // Match cd commands: cd /path/to/dir or cd "path with spaces"
  const cdMatch = command.match(/\bcd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (cdMatch) {
    const cdPath = cdMatch[1] || cdMatch[2] || cdMatch[3];
    if (cdPath && !cdPath.startsWith('-')) {
      paths.push(cdPath);
    }
  }

  // Match absolute paths in the command (common pattern: /home/user/project/...)
  const absolutePathRegex = /(?:^|\s|=|")(\/[^\s"'|;&<>]+)/g;
  let match;
  while ((match = absolutePathRegex.exec(command)) !== null) {
    const p = match[1];
    // Filter out common non-file paths
    if (p && !p.startsWith('/dev/') && !p.startsWith('/proc/') && !p.startsWith('/tmp/')) {
      paths.push(p);
    }
  }
}
