/**
 * Token count formatting utility
 * Formats large token counts into compact human-readable form.
 */

/**
 * Format a token count into compact notation with K/M suffixes.
 *
 * @param n - Non-negative integer token count
 * @returns Formatted string: "0", "123", "1.2K", "45.6K", "1.2M", etc.
 *
 * @example
 *   formatTokenCount(0)        // "0"
 *   formatTokenCount(999)      // "999"
 *   formatTokenCount(1234)     // "1.2K"
 *   formatTokenCount(1000000)  // "1.0M"
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return '0';
  }

  if (n < 1000) {
    return String(Math.round(n));
  }

  if (n < 999_950) {
    return (n / 1000).toFixed(1) + 'K';
  }

  return (n / 1_000_000).toFixed(1) + 'M';
}
