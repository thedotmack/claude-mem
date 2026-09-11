import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

function expandLeadingTilde(filePath: string): string {
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return join(homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Resolve a caller-supplied path and refuse anything that escapes the workspace.
 *
 * smart_unfold / smart_outline / smart_search used to `resolve()` the argument
 * with no containment check, so an MCP call could read ~/.ssh/id_rsa (and any
 * other file the OS user can read). path.resolve() is lexical only — it does
 * not follow symlinks — so both sides are realpath'd before the comparison.
 * Missing targets fall back to the lexical path so the caller still gets a
 * natural ENOENT, but only after the lexical path itself is known not to escape.
 *
 * @see thedotmack/claude-mem#3861
 */
export async function resolveWithinWorkspace(
  filePath: string,
  workspaceCwd: string = process.cwd(),
): Promise<string> {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('file_path is required');
  }

  const root = await realpath(resolve(workspaceCwd));
  const lexicallyResolved = resolve(root, expandLeadingTilde(filePath.trim()));
  let resolved: string;
  try {
    resolved = await realpath(lexicallyResolved);
  } catch {
    resolved = lexicallyResolved;
  }

  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(
      `Access denied: "${filePath}" resolves outside the workspace (${root}). ` +
      'MCP file tools can only read files within the current project.',
    );
  }

  return resolved;
}
