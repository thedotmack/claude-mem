import { logger } from '../../../utils/logger.js';

import {
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult,
  CombinedResult,
  SearchResults
} from './types.js';
import { ModeManager } from '../../domain/ModeManager.js';
import { formatTime, extractFirstFile, groupByDate, estimateTokens } from '../../../shared/timeline-formatting.js';

const CHARS_PER_TOKEN_ESTIMATE = 4;

export class ResultFormatter {
  formatSearchResults(
    results: SearchResults,
    query: string,
    chromaFailed: boolean = false
  ): string {
    const totalResults = results.observations.length +
      results.sessions.length +
      results.prompts.length;

    if (totalResults === 0) {
      if (chromaFailed) {
        return ResultFormatter.formatChromaFailureMessage({
          message: 'unknown error (no reason captured by caller)',
          isConnectionError: false,
        });
      }
      return `No results found matching "${query}"`;
    }

    const combined = this.combineResults(results);

    combined.sort((a, b) => b.epoch - a.epoch);

    const cwd = process.cwd();
    const resultsByDate = groupByDate(combined, item => item.created_at);

    const lines: string[] = [];
    lines.push(`Found ${totalResults} result(s) matching "${query}" (${results.observations.length} obs, ${results.sessions.length} sessions, ${results.prompts.length} prompts)`);
    lines.push('');

    for (const [day, dayResults] of resultsByDate) {
      lines.push(`### ${day}`);
      lines.push('');

      const resultsByFile = new Map<string, CombinedResult[]>();
      for (const result of dayResults) {
        let file = 'General';
        if (result.type === 'observation') {
          const obs = result.data as ObservationSearchResult;
          file = extractFirstFile(obs.files_modified, cwd, obs.files_read);
        }
        if (!resultsByFile.has(file)) {
          resultsByFile.set(file, []);
        }
        resultsByFile.get(file)!.push(result);
      }

      for (const [file, fileResults] of resultsByFile) {
        lines.push(`**${file}**`);
        lines.push(this.formatSearchTableHeader());

        let lastTime = '';
        for (const result of fileResults) {
          if (result.type === 'observation') {
            const formatted = this.formatObservationSearchRow(
              result.data as ObservationSearchResult,
              lastTime
            );
            lines.push(formatted.row);
            lastTime = formatted.time;
          } else if (result.type === 'session') {
            const formatted = this.formatSessionSearchRow(
              result.data as SessionSummarySearchResult,
              lastTime
            );
            lines.push(formatted.row);
            lastTime = formatted.time;
          } else {
            const formatted = this.formatPromptSearchRow(
              result.data as UserPromptSearchResult,
              lastTime
            );
            lines.push(formatted.row);
            lastTime = formatted.time;
          }
        }

        lines.push('');
      }
    }

    return lines.join('\n');
  }

  combineResults(results: SearchResults): CombinedResult[] {
    return [
      ...results.observations.map(obs => ({
        type: 'observation' as const,
        data: obs,
        epoch: obs.created_at_epoch,
        created_at: obs.created_at
      })),
      ...results.sessions.map(sess => ({
        type: 'session' as const,
        data: sess,
        epoch: sess.created_at_epoch,
        created_at: sess.created_at
      })),
      ...results.prompts.map(prompt => ({
        type: 'prompt' as const,
        data: prompt,
        epoch: prompt.created_at_epoch,
        created_at: prompt.created_at
      }))
    ];
  }

  formatSearchTableHeader(): string {
    return `| ID | Time | T | Title | Read |
|----|------|---|-------|------|`;
  }

  formatTableHeader(): string {
    return `| ID | Time | T | Title | Read | Work |
|-----|------|---|-------|------|------|`;
  }

  formatObservationSearchRow(
    obs: ObservationSearchResult,
    lastTime: string
  ): { row: string; time: string } {
    const id = `#${obs.id}`;
    const time = formatTime(obs.created_at_epoch);
    const icon = ModeManager.getInstance().getTypeIcon(obs.type);
    const title = obs.title || 'Untitled';
    const readTokens = this.estimateReadTokens(obs);

    const timeDisplay = time === lastTime ? '"' : time;

    return {
      row: `| ${id} | ${timeDisplay} | ${icon} | ${title} | ~${readTokens} |`,
      time
    };
  }

  formatSessionSearchRow(
    session: SessionSummarySearchResult,
    lastTime: string
  ): { row: string; time: string } {
    const id = `#S${session.id}`;
    const time = formatTime(session.created_at_epoch);
    const icon = '\uD83C\uDFAF'; 
    const title = session.request ||
      `Session ${session.memory_session_id?.substring(0, 8) || 'unknown'}`;

    const timeDisplay = time === lastTime ? '"' : time;

    return {
      row: `| ${id} | ${timeDisplay} | ${icon} | ${title} | - |`,
      time
    };
  }

  formatPromptSearchRow(
    prompt: UserPromptSearchResult,
    lastTime: string
  ): { row: string; time: string } {
    const id = `#P${prompt.id}`;
    const time = formatTime(prompt.created_at_epoch);
    const icon = '\uD83D\uDCAC'; 
    const title = prompt.prompt_text.length > 60
      ? prompt.prompt_text.substring(0, 57) + '...'
      : prompt.prompt_text;

    const timeDisplay = time === lastTime ? '"' : time;

    return {
      row: `| ${id} | ${timeDisplay} | ${icon} | ${title} | - |`,
      time
    };
  }

  formatObservationIndex(obs: ObservationSearchResult, _index: number): string {
    const id = `#${obs.id}`;
    const time = formatTime(obs.created_at_epoch);
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
    const time = formatTime(session.created_at_epoch);
    const icon = '\uD83C\uDFAF';
    const title = session.request ||
      `Session ${session.memory_session_id?.substring(0, 8) || 'unknown'}`;

    return `| ${id} | ${time} | ${icon} | ${title} | - | - |`;
  }

  formatPromptIndex(prompt: UserPromptSearchResult, _index: number): string {
    const id = `#P${prompt.id}`;
    const time = formatTime(prompt.created_at_epoch);
    const icon = '\uD83D\uDCAC';
    const title = prompt.prompt_text.length > 60
      ? prompt.prompt_text.substring(0, 57) + '...'
      : prompt.prompt_text;

    return `| ${id} | ${time} | ${icon} | ${title} | - | - |`;
  }

  private estimateReadTokens(obs: ObservationSearchResult): number {
    const size = (obs.title?.length || 0) +
      (obs.subtitle?.length || 0) +
      (obs.narrative?.length || 0) +
      (obs.facts?.length || 0);
    return Math.ceil(size / CHARS_PER_TOKEN_ESTIMATE);
  }

  static formatChromaFailureMessage(reason: { message: string; isConnectionError: boolean }): string {
    if (reason.isConnectionError) {
      return `Semantic search is offline (Chroma MCP unreachable: ${reason.message}). Falling back to keyword search; results may be incomplete. Run \`/api/chroma/status?deep=1\` to diagnose.`;
    }
    return `Semantic search failed: ${reason.message}. Falling back to keyword search; results may be incomplete. Check \`~/.claude-mem/logs/\` for the CHROMA_SYNC entry. Run \`/api/chroma/status?deep=1\` for a deeper probe.`;
  }

  formatSearchTips(): string {
    return `
---
Search Strategy:
1. Search with index to see titles, dates, IDs
2. Use timeline to get context around interesting results
3. Batch fetch full details: get_observations(ids=[...])

Tips:
- Filter by type: obs_type="bugfix,feature"
- Filter by date: dateStart="2025-01-01"
- Sort: orderBy="date_desc" or "date_asc"`;
  }
}
