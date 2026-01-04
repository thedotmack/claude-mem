/**
 * FormattingService - Handles all formatting logic for search results
 * Uses table format matching context-generator style for visual consistency
 */

import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../sqlite/types.js';
import { ModeManager } from '../domain/ModeManager.js';
import { logger } from '../../utils/logger.js';

// Token estimation constant (matches context-generator)
const CHARS_PER_TOKEN_ESTIMATE = 4;

export class FormattingService {
  /**
   * Format search tips footer
   */
  formatSearchTips(): string {
    return `\n---
💡 Search Strategy:
1. Search with index to see titles, dates, IDs
2. Use timeline to get context around interesting results
3. Batch fetch full details: get_observations(ids=[...])

Tips:
• Filter by type: obs_type="bugfix,feature"
• Filter by date: dateStart="2025-01-01"
• Sort: orderBy="date_desc" or "date_asc"`;
  }

  /**
   * Format time from epoch (matches context-generator formatTime)
   */
  private formatTime(epoch: number): string {
    return new Date(epoch).toLocaleString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }

  /**
   * Estimate read tokens for an observation
   */
  private estimateReadTokens(obs: ObservationSearchResult): number {
    const size = (obs.title?.length || 0) +
                 (obs.subtitle?.length || 0) +
                 (obs.narrative?.length || 0) +
                 (obs.facts?.length || 0);
    return Math.ceil(size / CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Format observation as table row
   * | ID | Time | T | Title | Read | Work |
   */
  formatObservationIndex(obs: ObservationSearchResult, _index: number): string {
    const id = `#${obs.id}`;
    const time = this.formatTime(obs.created_at_epoch);
    const icon = ModeManager.getInstance().getTypeIcon(obs.type);
    const title = obs.title || 'Untitled';
    const readTokens = this.estimateReadTokens(obs);
    const workEmoji = ModeManager.getInstance().getWorkEmoji(obs.type);
    const workTokens = obs.discovery_tokens || 0;
    const workDisplay = workTokens > 0 ? `${workEmoji} ${workTokens}` : '-';

    return `| ${id} | ${time} | ${icon} | ${title} | ~${readTokens} | ${workDisplay} |`;
  }

  /**
   * Format session summary as table row
   * | ID | Time | T | Title | - | - |
   */
  formatSessionIndex(session: SessionSummarySearchResult, _index: number): string {
    const id = `#S${session.id}`;
    const time = this.formatTime(session.created_at_epoch);
    const icon = '🎯';
    const title = session.request || `Session ${session.memory_session_id?.substring(0, 8) || 'unknown'}`;

    return `| ${id} | ${time} | ${icon} | ${title} | - | - |`;
  }

  /**
   * Format user prompt as table row
   * | ID | Time | T | Title | - | - |
   */
  formatUserPromptIndex(prompt: UserPromptSearchResult, _index: number): string {
    const id = `#P${prompt.id}`;
    const time = this.formatTime(prompt.created_at_epoch);
    const icon = '💬';
    // Truncate long prompts for table display
    const title = prompt.prompt_text.length > 60
      ? prompt.prompt_text.substring(0, 57) + '...'
      : prompt.prompt_text;

    return `| ${id} | ${time} | ${icon} | ${title} | - | - |`;
  }

  /**
   * Generate table header for observations
   */
  formatTableHeader(): string {
    return `| ID | Time | T | Title | Read | Work |
|-----|------|---|-------|------|------|`;
  }

  /**
   * Generate table header for search results (no Work column)
   */
  formatSearchTableHeader(): string {
    return `| ID | Time | T | Title | Read |
|----|------|---|-------|------|`;
  }

  /**
   * Format observation as table row for search results (no Work column)
   */
  formatObservationSearchRow(obs: ObservationSearchResult, lastTime: string): { row: string; time: string } {
    const id = `#${obs.id}`;
    const time = this.formatTime(obs.created_at_epoch);
    const icon = ModeManager.getInstance().getTypeIcon(obs.type);
    const title = obs.title || 'Untitled';
    const readTokens = this.estimateReadTokens(obs);

    // Use ditto mark if same time as previous row
    const timeDisplay = time === lastTime ? '″' : time;

    return {
      row: `| ${id} | ${timeDisplay} | ${icon} | ${title} | ~${readTokens} |`,
      time
    };
  }

  /**
   * Format session summary as table row for search results (no Work column)
   */
  formatSessionSearchRow(session: SessionSummarySearchResult, lastTime: string): { row: string; time: string } {
    const id = `#S${session.id}`;
    const time = this.formatTime(session.created_at_epoch);
    const icon = '🎯';
    const title = session.request || `Session ${session.memory_session_id?.substring(0, 8) || 'unknown'}`;

    // Use ditto mark if same time as previous row
    const timeDisplay = time === lastTime ? '″' : time;

    return {
      row: `| ${id} | ${timeDisplay} | ${icon} | ${title} | - |`,
      time
    };
  }

  /**
   * Format user prompt as table row for search results (no Work column)
   */
  formatUserPromptSearchRow(prompt: UserPromptSearchResult, lastTime: string): { row: string; time: string } {
    const id = `#P${prompt.id}`;
    const time = this.formatTime(prompt.created_at_epoch);
    const icon = '💬';
    // Truncate long prompts for table display
    const title = prompt.prompt_text.length > 60
      ? prompt.prompt_text.substring(0, 57) + '...'
      : prompt.prompt_text;

    // Use ditto mark if same time as previous row
    const timeDisplay = time === lastTime ? '″' : time;

    return {
      row: `| ${id} | ${timeDisplay} | ${icon} | ${title} | - |`,
      time
    };
  }
}
