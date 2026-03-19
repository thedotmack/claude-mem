/**
 * File Read Gate
 *
 * In-memory session-scoped gate tracking which files have had their timeline
 * injected. Prevents duplicate timeline injections within the same session.
 */

interface SessionEntry {
  files: Set<string>;
  createdAt: number;
}

const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

const sessionGates = new Map<string, SessionEntry>();

/**
 * Lazily prune session entries older than the TTL.
 */
function pruneExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, entry] of sessionGates) {
    if (now - entry.createdAt > TTL_MS) {
      sessionGates.delete(sessionId);
    }
  }
}

/**
 * Check if this is the first read of a file in a session, and mark it if so.
 * Returns true if this is the first attempt (file was not previously seen).
 * Returns false if the file was already seen in this session.
 */
export function checkAndMark(sessionId: string, filePath: string): boolean {
  pruneExpiredSessions();

  const normalizedPath = filePath.replace(/\\/g, '/');

  let entry = sessionGates.get(sessionId);
  if (!entry) {
    entry = { files: new Set(), createdAt: Date.now() };
    sessionGates.set(sessionId, entry);
  }

  if (entry.files.has(normalizedPath)) {
    return false;
  }

  entry.files.add(normalizedPath);
  return true;
}

/**
 * Clear all tracked files for a session (e.g., on session end).
 */
export function clearSession(sessionId: string): void {
  sessionGates.delete(sessionId);
}
