
import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../sqlite/types.js';
import { ModeManager } from '../domain/ModeManager.js';
import { logger } from '../../utils/logger.js';

const CHARS_PER_TOKEN_ESTIMATE = 4;

export class FormattingService {
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

  private formatTime(epoch: number): string {
    return new Date(epoch).toLocaleString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }

  private estimateReadTokens(obs: ObservationSearchResult): number {
    const size = (obs.title?.length || 0) +
                 (obs.subtitle?.length || 0) +
                 (obs.narrative?.length || 0) +
                 (obs.facts?.length || 0);
    return Math.ceil(size / CHARS_PER_TOKEN_ESTIMATE);
  }

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

  formatSessionIndex(session: SessionSummarySearchResult, _index: number): string {
    const id = `#S${session.id}`;
    const time = this.formatTime(session.created_at_epoch);
    const icon = '🎯';
    const title = session.request || `Session ${session.memory_session_id?.substring(0, 8) || 'unknown'}`;

    return `| ${id} | ${time} | ${icon} | ${title} | - | - |`;
  }

  formatUserPromptIndex(prompt: UserPromptSearchResult, _index: number): string {
    const id = `#P${prompt.id}`;
    const time = this.formatTime(prompt.created_at_epoch);
    const icon = '💬';
    const title = prompt.prompt_text.length > 60
      ? prompt.prompt_text.substring(0, 57) + '...'
      : prompt.prompt_text;

    return `| ${id} | ${time} | ${icon} | ${title} | - | - |`;
  }

  formatTableHeader(): string {
    return `| ID | Time | T | Title | Read | Work |
|-----|------|---|-------|------|------|`;
  }

  formatSearchTableHeader(): string {
    return `| ID | Time | T | Title | Read |
|----|------|---|-------|------|`;
  }

  formatObservationSearchRow(obs: ObservationSearchResult, lastTime: string): { row: string; time: string } {
    const id = `#${obs.id}`;
    const time = this.formatTime(obs.created_at_epoch);
    const icon = ModeManager.getInstance().getTypeIcon(obs.type);
    const title = obs.title || 'Untitled';
    const readTokens = this.estimateReadTokens(obs);

    const timeDisplay = time === lastTime ? '″' : time;

    return {
      row: `| ${id} | ${timeDisplay} | ${icon} | ${title} | ~${readTokens} |`,
      time
    };
  }

  formatSessionSearchRow(session: SessionSummarySearchResult, lastTime: string): { row: string; time: string } {
    const id = `#S${session.id}`;
    const time = this.formatTime(session.created_at_epoch);
    const icon = '🎯';
    const title = session.request || `Session ${session.memory_session_id?.substring(0, 8) || 'unknown'}`;

    const timeDisplay = time === lastTime ? '″' : time;

    return {
      row: `| ${id} | ${timeDisplay} | ${icon} | ${title} | - |`,
      time
    };
  }

  formatUserPromptSearchRow(prompt: UserPromptSearchResult, lastTime: string): { row: string; time: string } {
    const id = `#P${prompt.id}`;
    const time = this.formatTime(prompt.created_at_epoch);
    const icon = '💬';
    const title = prompt.prompt_text.length > 60
      ? prompt.prompt_text.substring(0, 57) + '...'
      : prompt.prompt_text;

    const timeDisplay = time === lastTime ? '″' : time;

    return {
      row: `| ${id} | ${timeDisplay} | ${icon} | ${title} | - |`,
      time
    };
  }
}
