import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';

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
    } catch (error) {
      // A path changed or vanished while resolving it: keep the launch directory.
      logger.warn('SYSTEM', 'MCP could not compare the launch directory with the plugin root; using the launch directory',
        {}, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return { cwd: fallback, source: 'process' };
}

/** The part of the MCP Server the stdio resolver uses: the client's capabilities and roots/list. */
export interface StdioRootsPeer {
  getClientCapabilities(): { roots?: unknown } | undefined;
  listRoots(params?: undefined, options?: { timeout?: number }): Promise<{ roots: Array<{ uri: string }> }>;
}

/**
 * The project directory for stdio tool calls. A client that declares the roots
 * capability is asked (overlapping calls share one request), and its answer is
 * kept until the client reports a change; a refresh that fails keeps that last
 * good answer. A client without the capability is never asked, so it gets the
 * launch directory exactly as before (or PWD when launched inside the plugin).
 */
export function createStdioCwdResolver(options: {
  peer: StdioRootsPeer;
  pluginRoot: string;
  processCwd?: () => string;
  pwd?: () => string | undefined;
}): { resolve(): Promise<string>; markRootsStale(): void } {
  const { peer, pluginRoot } = options;
  const processCwd = options.processCwd ?? (() => process.cwd());
  const pwd = options.pwd ?? (() => process.env.PWD);
  let lastRoots: McpCwdResolution | null = null;
  let rootsAttempts = 0;
  let rootsStale = false;
  let rootsRevision = 0;
  let rootsInFlight: Promise<void> | undefined;
  let rootsInFlightRevision: number | undefined;
  let logged: McpCwdResolution | null = null;

  const refreshRoots = async (revision: number): Promise<void> => {
    rootsAttempts++;
    try {
      const { roots } = await peer.listRoots(undefined, { timeout: MCP_ROOTS_TIMEOUT_MS });
      if (revision !== rootsRevision) return;
      const cwd = cwdFromRoots(roots);
      lastRoots = cwd ? { cwd, source: 'roots' } : null;
      rootsStale = false;
    } catch (error) {
      if (revision !== rootsRevision) return;
      logger.warn('SYSTEM', lastRoots
        ? 'MCP stdio roots/list failed; keeping the last roots answer'
        : 'MCP stdio roots/list failed; using the launch directory', {
        attempt: rootsAttempts,
        maxAttempts: MAX_MCP_ROOTS_ATTEMPTS,
      }, error instanceof Error ? error : new Error(String(error)));
    }
  };

  return {
    markRootsStale() {
      rootsRevision++;
      rootsStale = true;
      rootsAttempts = 0;
    },
    async resolve() {
      const supportsRoots = Boolean(peer.getClientCapabilities()?.roots);
      while (supportsRoots) {
        const wantsRoots = (lastRoots === null || rootsStale)
          && rootsAttempts < MAX_MCP_ROOTS_ATTEMPTS;
        if (wantsRoots && !rootsInFlight) {
          const revision = rootsRevision;
          rootsInFlightRevision = revision;
          rootsInFlight = refreshRoots(revision).finally(() => {
            rootsInFlight = undefined;
            rootsInFlightRevision = undefined;
          });
        }
        if (!rootsInFlight) break;
        const pending = rootsInFlight;
        const pendingRevision = rootsInFlightRevision;
        await pending;
        if (pendingRevision !== rootsRevision && rootsAttempts < MAX_MCP_ROOTS_ATTEMPTS) continue;
        break;
      }
      const resolution = lastRoots ?? resolveMcpProjectCwd({ fallbackCwd: processCwd(), pwd: pwd(), pluginRoot });
      if (!logged || logged.source !== resolution.source || logged.cwd !== resolution.cwd) {
        // Kept path-free: this records which source won, not a project path.
        logger.info('SYSTEM', `MCP stdio working directory resolved from ${resolution.source}`);
        logged = resolution;
      }
      return resolution.cwd;
    },
  };
}
