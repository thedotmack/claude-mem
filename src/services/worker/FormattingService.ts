/**
 * FormattingService - Handles all formatting logic for search results
 * Extracted from mcp-server.ts to follow worker service organization pattern
 */

import { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../sqlite/types.js';

export type FormatType = 'index' | 'full';

export class FormattingService {
  /**
   * Format search tips footer
   */
  formatSearchTips(): string {
    return `\n---
💡 Search Strategy:
ALWAYS search with index format FIRST to get an overview and identify relevant results.
This is critical for token efficiency - index format uses ~10x fewer tokens than full format.

Search workflow:
1. Initial search: Use default (index) format to see titles, dates, and sources
2. Review results: Identify which items are most relevant to your needs
3. Deep dive: Only then use format: "full" on specific items of interest
4. Narrow down: Use filters (type, dateStart/dateEnd, concepts, files) to refine results

Other tips:
• To search by concept: Use find_by_concept tool
• To browse by type: Use find_by_type with ["decision", "feature", etc.]
• To sort by date: Use orderBy: "date_desc" or "date_asc"`;
  }

  /**
   * Format observation as index entry (title, date, ID only)
   */
  formatObservationIndex(obs: ObservationSearchResult, index: number): string {
    const title = obs.title || `Observation #${obs.id}`;
    const date = new Date(obs.created_at_epoch).toLocaleString();
    const type = obs.type ? `[${obs.type}]` : '';

    return `${index + 1}. ${type} ${title}
   Date: ${date}
   Source: claude-mem://observation/${obs.id}`;
  }

  /**
   * Format session summary as index entry (title, date, ID only)
   */
  formatSessionIndex(session: SessionSummarySearchResult, index: number): string {
    const title = session.request || `Session ${session.sdk_session_id?.substring(0, 8) || 'unknown'}`;
    const date = new Date(session.created_at_epoch).toLocaleString();

    return `${index + 1}. ${title}
   Date: ${date}
   Source: claude-mem://session/${session.sdk_session_id}`;
  }

  /**
   * Format user prompt as index entry (full text - don't truncate context!)
   */
  formatUserPromptIndex(prompt: UserPromptSearchResult, index: number): string {
    const date = new Date(prompt.created_at_epoch).toLocaleString();

    return `${index + 1}. "${prompt.prompt_text}"
   Date: ${date} | Prompt #${prompt.prompt_number}
   Source: claude-mem://user-prompt/${prompt.id}`;
  }

  /**
   * Format observation as text content with metadata
   */
  formatObservationResult(obs: ObservationSearchResult): string {
    const title = obs.title || `Observation #${obs.id}`;

    // Build content from available fields
    const contentParts: string[] = [];
    contentParts.push(`## ${title}`);
    contentParts.push(`*Source: claude-mem://observation/${obs.id}*`);
    contentParts.push('');

    if (obs.subtitle) {
      contentParts.push(`**${obs.subtitle}**`);
      contentParts.push('');
    }

    if (obs.narrative) {
      contentParts.push(obs.narrative);
      contentParts.push('');
    }

    if (obs.text) {
      contentParts.push(obs.text);
      contentParts.push('');
    }

    // Add metadata
    const metadata: string[] = [];
    metadata.push(`Type: ${obs.type}`);

    if (obs.facts) {
      try {
        const facts = JSON.parse(obs.facts);
        if (facts.length > 0) {
          metadata.push(`Facts: ${facts.join('; ')}`);
        }
      } catch {}
    }

    if (obs.concepts) {
      try {
        const concepts = JSON.parse(obs.concepts);
        if (concepts.length > 0) {
          metadata.push(`Concepts: ${concepts.join(', ')}`);
        }
      } catch {}
    }

    if (obs.files_read || obs.files_modified) {
      const files: string[] = [];
      if (obs.files_read) {
        try {
          files.push(...JSON.parse(obs.files_read));
        } catch {}
      }
      if (obs.files_modified) {
        try {
          files.push(...JSON.parse(obs.files_modified));
        } catch {}
      }
      if (files.length > 0) {
        metadata.push(`Files: ${[...new Set(files)].join(', ')}`);
      }
    }

    if (metadata.length > 0) {
      contentParts.push('---');
      contentParts.push(metadata.join(' | '));
    }

    // Add date
    const date = new Date(obs.created_at_epoch).toLocaleString();
    contentParts.push('');
    contentParts.push(`---`);
    contentParts.push(`Date: ${date}`);

    return contentParts.join('\n');
  }

  /**
   * Format session summary as text content with metadata
   */
  formatSessionResult(session: SessionSummarySearchResult): string {
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

  /**
   * Format user prompt as text content with metadata
   */
  formatUserPromptResult(prompt: UserPromptSearchResult): string {
    const contentParts: string[] = [];
    contentParts.push(`## User Prompt #${prompt.prompt_number}`);
    contentParts.push(`*Source: claude-mem://user-prompt/${prompt.id}*`);
    contentParts.push('');
    contentParts.push(prompt.prompt_text);
    contentParts.push('');
    contentParts.push('---');

    const date = new Date(prompt.created_at_epoch).toLocaleString();
    contentParts.push(`Date: ${date}`);

    return contentParts.join('\n');
  }
}
