/**
 * Shared formatting utilities — extracted from formatters/table.ts to keep
 * pure functions reusable across formatters, commands, and future output
 * modes (markdown, JSON summary, etc.) without pulling in chalk or cli-table3.
 */

/**
 * Format a byte count as a human-readable string.
 *
 * @example
 *   formatBytes(512)          // "512 B"
 *   formatBytes(2048)         // "2.0 KB"
 *   formatBytes(3_145_728)    // "3.0 MB"
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format a duration in seconds as a compact human-readable string.
 *
 * @example
 *   formatUptime(45)     // "45s"
 *   formatUptime(125)    // "2m 5s"
 *   formatUptime(3_661)  // "1h 1m"
 */
export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/**
 * Format a Unix epoch (milliseconds) as a concise, context-aware timestamp.
 *
 * - Same day   → "3:42 PM"
 * - Yesterday  → "Yesterday 3:42 PM"
 * - Older      → "Mar 13 3:42 PM"
 *
 * All output uses the runtime locale for month names and time notation.
 */
export function formatTimestamp(epoch: number): string {
  const d = new Date(epoch);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();

  if (isToday) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return 'Yesterday ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }

  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  );
}
