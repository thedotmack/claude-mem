import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_ROOTS_TIMEOUT_MS = 2000;
export const MAX_MCP_ROOTS_ATTEMPTS = 3;

export type McpCwdSource = 'header' | 'roots' | 'pwd' | 'process';

export interface McpCwdResolution {
  cwd: string;
  source: McpCwdSource;
}

/** A usable directory from an absolute path or file:// URI, or null. */
export function normalizeCwd(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null;
  let candidate = value.trim();
  if (candidate.length === 0 || candidate.includes('\0')) return null;
  if (candidate.startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return null;
    }
  }
  if (!isAbsolute(candidate)) return null;
  const resolved = resolve(candidate);
  try {
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/** The first usable directory in an MCP `roots/list` result. */
export function cwdFromRoots(roots: ReadonlyArray<{ uri: string }> | undefined): string | null {
  for (const root of roots ?? []) {
    const cwd = normalizeCwd(root.uri);
    if (cwd) return cwd;
  }
  return null;
}

function isWithinDirectory(directory: string, parent: string): boolean {
  const realDirectory = realpathSync.native(directory);
  const realParent = realpathSync.native(parent);
  const relativePath = relative(realParent, realDirectory);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

/**
 * Resolve the project for one MCP call. A client-provided header or roots/list
 * answer wins; PWD is only a fallback when the server was launched from inside
 * its own plugin, where process.cwd() is not the project directory.
 */
export function resolveMcpProjectCwd(options: {
  headerCwd?: string | null;
  roots?: ReadonlyArray<{ uri: string }>;
  fallbackCwd: string;
  pwd?: string | null;
  pluginRoot?: string | null;
}): McpCwdResolution {
  const header = normalizeCwd(options.headerCwd);
  if (header) return { cwd: header, source: 'header' };

  const roots = cwdFromRoots(options.roots);
  if (roots) return { cwd: roots, source: 'roots' };

  const fallback = normalizeCwd(options.fallbackCwd) ?? resolve(options.fallbackCwd);
  const pluginRoot = normalizeCwd(options.pluginRoot);
  if (pluginRoot) {
    try {
      if (isWithinDirectory(fallback, pluginRoot)) {
        const pwd = normalizeCwd(options.pwd);
        if (pwd) return { cwd: pwd, source: 'pwd' };
      }
    } catch {
      // If a path changes while resolving it, keep the existing process cwd.
    }
  }
  return { cwd: fallback, source: 'process' };
}
