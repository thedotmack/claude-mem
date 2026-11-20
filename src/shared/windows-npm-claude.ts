import { win32 } from 'path';

/**
 * Clean up Windows PATH hits for `claude` from a global npm install (#5163).
 *
 * `npm install -g @anthropic-ai/claude-code` puts three shims on PATH:
 * an extension-less sh script (for Git Bash), claude.cmd and claude.ps1.
 * The real claude.exe stays inside the package. Windows cannot launch the sh
 * script as a program, and the SDK cannot spawn a .cmd shim without a shell,
 * so neither should reach it when the package's claude.exe is right there.
 *
 * Returns the hits without extension-less files, plus the package's
 * claude.exe for each .cmd shim whose folder has one.
 */
export function withNpmClaudeExe(hits: readonly string[], exists: (path: string) => boolean): string[] {
  const result: string[] = [];
  for (const hit of hits) {
    const ext = win32.extname(hit).toLowerCase();
    if (ext === '') continue;
    result.push(hit);
    if (ext !== '.cmd') continue;
    const packageExe = win32.join(win32.dirname(hit), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (exists(packageExe)) {
      result.push(packageExe);
    }
  }
  return result;
}
