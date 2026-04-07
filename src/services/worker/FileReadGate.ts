/**
 * File Read Gate
 *
 * In-memory session-scoped gate tracking which files have had their timeline
 * injected. Prevents duplicate timeline injections within the same session.
 * Keys include cwd to prevent worktree collisions.
 */

interface SessionEntry {
  files: Set<string>;
  lastAccess: number;
}

const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

const sessionGates = new Map<string, SessionEntry>();

let pruneCallCount = 0;
const PRUNE_EVERY_N_CALLS = 50;

/**
 * Lazily prune session entries older than the TTL.
 * Throttled to run every N calls to avoid iterating all sessions on every check.
 */
function pruneExpiredSessions(): void {
  pruneCallCount++;
  if (pruneCallCount < PRUNE_EVERY_N_CALLS) return;
  pruneCallCount = 0;

  const now = Date.now();
  for (const [key, entry] of sessionGates) {
    if (now - entry.lastAccess > TTL_MS) {
      sessionGates.delete(key);
    }
  }
}

/**
 * Build a composite key scoped to session + cwd to prevent worktree collisions.
 */
function makeKey(sessionId: string, cwd?: string): string {
  return cwd ? `${sessionId}::${cwd}` : sessionId;
}

/**
 * Check if this is the first read of a file in a session+cwd scope, and mark it if so.
 * Returns true if this is the first attempt (file was not previously seen).
 * Returns false if the file was already seen in this session.
 */
export function checkAndMark(sessionId: string, filePath: string, cwd?: string): boolean {
  pruneExpiredSessions();

  const key = makeKey(sessionId, cwd);
  const normalizedPath = filePath.replace(/\\/g, '/');

  let entry = sessionGates.get(key);
  if (!entry) {
    entry = { files: new Set(), lastAccess: Date.now() };
    sessionGates.set(key, entry);
  }

  // Refresh TTL on every access so active sessions don't get re-blocked
  entry.lastAccess = Date.now();

  if (entry.files.has(normalizedPath)) {
    return false;
  }

  entry.files.add(normalizedPath);
  return true;
}

/**
 * Clear all tracked files for a session (e.g., on session end).
 * Clears all cwd scopes for the given session.
 */
export function clearSession(sessionId: string): void {
  for (const key of sessionGates.keys()) {
    if (key === sessionId || key.startsWith(`${sessionId}::`)) {
      sessionGates.delete(key);
    }
  }
}
