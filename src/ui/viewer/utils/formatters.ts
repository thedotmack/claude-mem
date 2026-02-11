/**
 * Formatting utility functions with comprehensive edge case handling
 */

const FALLBACK = '-';

/**
 * Format epoch timestamp to locale string with error handling
 */
export function formatDate(epoch?: number | null): string {
  if (!epoch || epoch <= 0) return FALLBACK;
  
  try {
    return new Date(epoch).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return FALLBACK;
  }
}

/**
 * Format seconds into human-readable duration
 */
export function formatUptime(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return FALLBACK;
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/**
 * Format bytes with adaptive precision
 */
export function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return FALLBACK;
  
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  const precision = unitIndex === 0 ? 0 : size < 10 ? 1 : 0;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

/**
 * Format count with thousand separators
 */
export function formatCount(count?: number | null): string {
  if (count == null || count < 0) return FALLBACK;
  return count.toLocaleString();
}

/**
 * Truncate text with smart word boundary detection
 */
export function truncateText(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) return text;
  
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  
  // If we can break at a word boundary within the last 20% of the limit
  if (lastSpace > maxLength * 0.8) {
    return truncated.slice(0, lastSpace) + '…';
  }
  
  return truncated + '…';
}