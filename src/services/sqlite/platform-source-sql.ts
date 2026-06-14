import { DEFAULT_PLATFORM_SOURCE } from '../../shared/platform-source.js';
import { logger } from '../../utils/logger.js';

const SQL_ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function warnIfUnexpectedAlias(alias: string): void {
  if (!SQL_ALIAS_PATTERN.test(alias)) {
    logger.warn('DB', 'Unexpected SQL alias used while composing platform source filter', { alias });
  }
}

function projectFallbackSql(recordAlias: string): string {
  warnIfUnexpectedAlias(recordAlias);

  return `CASE
    WHEN LOWER(${recordAlias}.project) = 'openclaw'
      OR LOWER(${recordAlias}.project) LIKE 'openclaw-%'
    THEN 'openclaw'
    ELSE '${DEFAULT_PLATFORM_SOURCE}'
  END`;
}

export function platformSourceSql(recordAlias: string, sessionAlias: string = 's'): string {
  warnIfUnexpectedAlias(sessionAlias);

  return `COALESCE(NULLIF(TRIM(${sessionAlias}.platform_source), ''), ${projectFallbackSql(recordAlias)})`;
}

export function platformSourceSubquerySql(recordAlias: string, sessionAlias: string = 's2'): string {
  warnIfUnexpectedAlias(recordAlias);
  warnIfUnexpectedAlias(sessionAlias);

  return `COALESCE(
    (
      SELECT NULLIF(TRIM(${sessionAlias}.platform_source), '')
      FROM sdk_sessions ${sessionAlias}
      WHERE ${sessionAlias}.memory_session_id = ${recordAlias}.memory_session_id
      LIMIT 1
    ),
    ${projectFallbackSql(recordAlias)}
  )`;
}
