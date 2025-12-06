import { SessionSummarySearchResult } from '../../../services/sqlite/types.js';

/**
 * Format session summary as index entry (title, date, ID only)
 */
export function formatSessionIndex(session: SessionSummarySearchResult, index: number): string {
  const title = session.request || `Session ${session.sdk_session_id?.substring(0, 8) || 'unknown'}`;
  const date = new Date(session.created_at_epoch).toLocaleString();

  return `${index + 1}. ${title}
   Date: ${date}
   Source: claude-mem://session/${session.sdk_session_id}`;
}

/**
 * Format session summary as text content with metadata
 */
export function formatSessionResult(session: SessionSummarySearchResult): string {
  const title = session.request || `Session ${session.sdk_session_id?.substring(0, 8) || 'unknown'}`;

  // Build content from available fields
  const contentParts: string[] = [];
  contentParts.push(`## ${title}`);
  contentParts.push(`*Source: claude-mem://session/${session.sdk_session_id}*`);
  contentParts.push('');

  if (session.completed) {
    contentParts.push(`**Completed:** ${session.completed}`);
    contentParts.push('');
  }

  if (session.learned) {
    contentParts.push(`**Learned:** ${session.learned}`);
    contentParts.push('');
  }

  if (session.investigated) {
    contentParts.push(`**Investigated:** ${session.investigated}`);
    contentParts.push('');
  }

  if (session.next_steps) {
    contentParts.push(`**Next Steps:** ${session.next_steps}`);
    contentParts.push('');
  }

  if (session.notes) {
    contentParts.push(`**Notes:** ${session.notes}`);
    contentParts.push('');
  }

  // Add metadata
  const metadata: string[] = [];

  if (session.files_read || session.files_edited) {
    const files: string[] = [];
    if (session.files_read) {
      try {
        files.push(...JSON.parse(session.files_read));
      } catch {}
    }
    if (session.files_edited) {
      try {
        files.push(...JSON.parse(session.files_edited));
      } catch {}
    }
    if (files.length > 0) {
      metadata.push(`Files: ${[...new Set(files)].join(', ')}`);
    }
  }

  const date = new Date(session.created_at_epoch).toLocaleDateString();
  metadata.push(`Date: ${date}`);

  if (metadata.length > 0) {
    contentParts.push('---');
    contentParts.push(metadata.join(' | '));
  }

  return contentParts.join('\n');
}
