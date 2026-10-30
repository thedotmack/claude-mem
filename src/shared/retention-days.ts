/**
 * A `*_RETENTION_DAYS` setting as a whole number of days. 0 means keep
 * forever, and so does anything that is not a plain non-negative integer: a
 * typo in a hand-edited settings.json must never turn into a purge, and must
 * never stop the worker from starting. settings.json is hand-editable JSON, so
 * the value may arrive as an unquoted number (`30`) as well as a string (`"30"`);
 * both mean 30 days. Any other type is ignored.
 *
 * Shared by CLAUDE_MEM_TOOL_USES_RETENTION_DAYS and CLAUDE_MEM_LOG_RETENTION_DAYS.
 */
export function parseRetentionDays(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  }
  if (typeof raw !== 'string') return 0;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  const days = Number(trimmed);
  return Number.isSafeInteger(days) ? days : 0;
}
