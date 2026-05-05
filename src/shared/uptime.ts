// F3 foundation: derive uptime in seconds from a start timestamp in ms.
// Clamps to >= 0 so a future startedAtMs or a non-monotonic clock skew doesn't
// surface negative uptime to health/status endpoints
// (CodeRabbit review on PR #2282).
export function getUptimeSeconds(startedAtMs: number, now: () => number = Date.now): number {
  return Math.max(0, Math.floor((now() - startedAtMs) / 1000));
}
