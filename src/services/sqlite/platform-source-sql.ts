import { DEFAULT_PLATFORM_SOURCE } from '../../shared/platform-source.js';

function projectFallbackSql(recordAlias: string): string {
  return `CASE
    WHEN LOWER(${recordAlias}.project) = 'openclaw'
      OR LOWER(${recordAlias}.project) LIKE 'openclaw-%'
    THEN 'openclaw'
    ELSE '${DEFAULT_PLATFORM_SOURCE}'
  END`;
}

export function platformSourceSql(recordAlias: string, sessionAlias: string = 's'): string {
  return `COALESCE(NULLIF(TRIM(${sessionAlias}.platform_source), ''), ${projectFallbackSql(recordAlias)})`;
}

export function platformSourceSubquerySql(recordAlias: string, sessionAlias: string = 's2'): string {
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
