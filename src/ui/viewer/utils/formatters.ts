/**
 * Formatting utility functions
 * Used across UI components for consistent display
 */

/**
 * Format epoch timestamp to locale string
 * @param epoch - Timestamp in milliseconds since epoch
 * @returns Formatted date string
 */
export function formatDate(epoch: number): string {
  return new Date(epoch).toLocaleString();
}

/**
 * Format seconds into hours and minutes
 * @param seconds - Uptime in seconds
 * @returns Formatted string like "12h 34m" or "-" if no value
 */
export function formatUptime(seconds?: number): string {
  if (!seconds) return '-';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/**
 * Format bytes into human-readable size
 * @param bytes - Size in bytes
 * @returns Formatted string like "1.5 MB" or "-" if no value
 */
export function formatBytes(bytes?: number): string {
  if (!bytes) return '-';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
