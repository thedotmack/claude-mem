import { lstat, realpath, unlink } from 'fs/promises';
import path from 'path';
import { CLAUDE_CONFIG_DIR, OBSERVER_SESSIONS_DIR } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';
import { cwdToDashed } from '../../context/ObservationCompiler.js';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ObserverTranscriptCleanupResult =
  | 'deleted'
  | 'missing'
  | 'invalid'
  | 'unsafe'
  | 'failed';

export function resolveObserverTranscriptPath(
  sessionId: string | null | undefined,
  claudeConfigDir: string = CLAUDE_CONFIG_DIR,
  observerSessionsDir: string = OBSERVER_SESSIONS_DIR,
): string | null {
  if (!sessionId || !CANONICAL_UUID.test(sessionId)) return null;

  const observerProjectDir = path.resolve(
    claudeConfigDir,
    'projects',
    cwdToDashed(observerSessionsDir),
  );
  const transcriptPath = path.resolve(observerProjectDir, `${sessionId}.jsonl`);

  return path.dirname(transcriptPath) === observerProjectDir ? transcriptPath : null;
}

async function resolveSafeObserverTranscriptPath(
  transcriptPath: string,
  claudeConfigDir: string,
): Promise<string | null> {
  const lexicalConfigRoot = path.resolve(claudeConfigDir);
  const relativeTranscriptPath = path.relative(lexicalConfigRoot, transcriptPath);
  if (
    relativeTranscriptPath === '..'
    || relativeTranscriptPath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeTranscriptPath)
  ) {
    return null;
  }

  const canonicalConfigRoot = await realpath(lexicalConfigRoot);
  const pathParts = relativeTranscriptPath.split(path.sep);
  let currentPath = canonicalConfigRoot;

  for (const pathPart of pathParts.slice(0, -1)) {
    currentPath = path.join(currentPath, pathPart);
    const entry = await lstat(currentPath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
  }

  return path.join(currentPath, pathParts[pathParts.length - 1]);
}

export async function removeObserverTranscriptForSession(
  sessionId: string | null | undefined,
  claudeConfigDir: string = CLAUDE_CONFIG_DIR,
  observerSessionsDir: string = OBSERVER_SESSIONS_DIR,
): Promise<ObserverTranscriptCleanupResult> {
  const transcriptPath = resolveObserverTranscriptPath(
    sessionId,
    claudeConfigDir,
    observerSessionsDir,
  );
  if (!transcriptPath) {
    logger.warn('SESSION', 'Skipping observer transcript cleanup for invalid session ID');
    return 'invalid';
  }

  try {
    const safeTranscriptPath = await resolveSafeObserverTranscriptPath(
      transcriptPath,
      claudeConfigDir,
    );
    if (!safeTranscriptPath) {
      logger.warn('SESSION', 'Skipping observer transcript cleanup through unsafe parent path', {
        memorySessionId: sessionId,
        transcriptPath,
      });
      return 'unsafe';
    }

    const entry = await lstat(safeTranscriptPath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      logger.warn('SESSION', 'Skipping unsafe observer transcript entry', {
        memorySessionId: sessionId,
        transcriptPath: safeTranscriptPath,
      });
      return 'unsafe';
    }

    await unlink(safeTranscriptPath);
    logger.info('SESSION', 'Removed completed observer transcript', {
      memorySessionId: sessionId,
      transcriptPath: safeTranscriptPath,
    });
    return 'deleted';
  } catch (error: unknown) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if ((normalized as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';

    logger.warn('SESSION', 'Failed to remove completed observer transcript', {
      memorySessionId: sessionId,
      transcriptPath,
    }, normalized);
    return 'failed';
  }
}
