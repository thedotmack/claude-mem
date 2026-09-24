/**
 * Parse the keepalive interval setting (`CLAUDE_MEM_KEEPALIVE_INTERVAL_MS`).
 *
 * Returns the interval in milliseconds, or `0` when keepalives are off. Only a
 * complete positive-integer string counts as enabled: `parseInt` would read
 * `"5000ms"` — or a non-string value coerced from settings.json, such as
 * `[5000]` — as `5000` and silently re-enable the off switch, so any malformed
 * value must fall through to off (#4159).
 */
export function parseKeepaliveIntervalMs(raw: unknown): number {
  if (typeof raw !== 'string') return 0;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  const ms = Number(trimmed);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : 0;
}
