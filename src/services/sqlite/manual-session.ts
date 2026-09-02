import type { Database } from 'bun:sqlite';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource } from '../../shared/platform-source.js';
import { logger } from '../../utils/logger.js';
import { SessionStore } from './SessionStore.js';

// SessionStore.getOrCreateManualSession is the shipped implementation
// (plugin/sqlite/SessionStore.js). This helper stays in sync and still
// patches the source prototype for tests that import it first.

export function getOrCreateManualSession(
  db: Database,
  project: string,
  platformSource: string = DEFAULT_PLATFORM_SOURCE,
): string {
  const normalizedPlatformSource = normalizePlatformSource(platformSource);
  const memorySessionId = `manual-${project}-${normalizedPlatformSource}`;
  const contentSessionId = `manual-content-${project}-${normalizedPlatformSource}`;

  const existing = db.prepare(
    'SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?',
  ).get(memorySessionId) as { memory_session_id: string } | undefined;

  if (existing) {
    return memorySessionId;
  }

  const now = new Date();
  db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(memorySessionId, contentSessionId, project, normalizedPlatformSource, now.toISOString(), now.getTime());

  logger.info('SESSION', 'Created manual session', { memorySessionId, project, platformSource: normalizedPlatformSource });
  return memorySessionId;
}

SessionStore.prototype.getOrCreateManualSession = function (
  this: SessionStore,
  project: string,
  platformSource: string = DEFAULT_PLATFORM_SOURCE,
): string {
  return getOrCreateManualSession(this.db, project, platformSource);
};
