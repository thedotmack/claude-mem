/**
 * Time utilities for formatting relative timestamps
 */

export function formatRelativeTime(timestamp: string | Date): string {
  try {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);

    if (diffSeconds < 60) {
      return 'Just now';
    } else if (diffMinutes < 60) {
      return diffMinutes === 1 ? '1 minute ago' : `${diffMinutes} minutes ago`;
    } else if (diffHours < 24) {
      return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`;
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return `${diffDays} days ago`;
    } else if (diffWeeks === 1) {
      return '1 week ago';
    } else if (diffWeeks < 4) {
      return `${diffWeeks} weeks ago`;
    } else if (diffMonths === 1) {
      return '1 month ago';
    } else if (diffMonths < 12) {
      return `${diffMonths} months ago`;
    } else {
      const diffYears = Math.floor(diffMonths / 12);
      return diffYears === 1 ? '1 year ago' : `${diffYears} years ago`;
    }
  } catch (error) {
    // Return a fallback for invalid timestamps
    return 'Recently';
  }
}

export function parseTimestamp(entry: any): Date | null {
  // Try multiple timestamp fields that might exist
  const possibleFields = ['timestamp', 'created_at', 'date', 'time'];
  
  for (const field of possibleFields) {
    if (entry[field]) {
      try {
        const date = new Date(entry[field]);
        if (!isNaN(date.getTime())) {
          return date;
        }
      } catch {
        continue;
      }
    }
  }
  
  // If no valid timestamp found, return null
  return null;
}