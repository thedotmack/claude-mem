// F3 foundation: derive uptime in seconds from a start timestamp in ms.
export function getUptimeSeconds(startedAtMs: number, now: () => number = Date.now): number {
  return Math.floor((now() - startedAtMs) / 1000);
}
