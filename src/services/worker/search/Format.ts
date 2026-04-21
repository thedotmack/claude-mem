/**
 * Format - unified formatters for search/timeline output.
 *
 * Replaces three near-identical timeline renderers in SearchManager.ts and merges
 * the row/header helpers from the former FormattingService.
 */

import type {
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult,
} from '../../sqlite/types.js';
import type { TimelineItem } from '../TimelineService.js';
import { ModeManager } from '../../domain/ModeManager.js';
import {
  formatDate,
  formatTime,
  formatDateTime,
  extractFirstFile,
  estimateTokens,
} from '../../../shared/timeline-formatting.js';

const CHARS_PER_TOKEN_ESTIMATE = 4;

export interface TimelineFormatOptions {
  items: TimelineItem[];
  anchorId: string | number;
  title: string;
  window: string;
  cwd?: string;
}

/**
 * Render a day-grouped, file-sectioned table timeline.
 * Anchor marker is applied when the item matches anchorId (number => observation id,
 * string starting with 'S' => session id).
 */
export function formatTimeline(opts: TimelineFormatOptions): string {
  const { items, anchorId, title, window } = opts;
  const cwd = opts.cwd ?? process.cwd();
  const lines: string[] = [];

  lines.push(title);
  lines.push(window);
  lines.push('');

  const dayMap = new Map<string, TimelineItem[]>();
  for (const item of items) {
    const day = formatDate(item.epoch);
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day)!.push(item);
  }

  const sortedDays = Array.from(dayMap.entries()).sort((a, b) => {
    return new Date(a[0]).getTime() - new Date(b[0]).getTime();
  });

  for (const [day, dayItems] of sortedDays) {
    lines.push(`### ${day}`);
    lines.push('');

    let currentFile: string | null = null;
    let lastTime = '';
    let tableOpen = false;

    for (const item of dayItems) {
      const isAnchor =
        (typeof anchorId === 'number' && item.type === 'observation' && item.data.id === anchorId) ||
        (typeof anchorId === 'string' && anchorId.startsWith('S') && item.type === 'session' && `S${item.data.id}` === anchorId);

      if (item.type === 'session') {
        if (tableOpen) {
          lines.push('');
          tableOpen = false;
          currentFile = null;
          lastTime = '';
        }
        const sess = item.data as SessionSummarySearchResult;
        const sessTitle = sess.request || 'Session summary';
        const marker = isAnchor ? ' <- **ANCHOR**' : '';
        lines.push(`**\uD83C\uDFAF #S${sess.id}** ${sessTitle} (${formatDateTime(item.epoch)})${marker}`);
        lines.push('');
      } else if (item.type === 'prompt') {
        if (tableOpen) {
          lines.push('');
          tableOpen = false;
          currentFile = null;
          lastTime = '';
        }
        const prompt = item.data as UserPromptSearchResult;
        const truncated = prompt.prompt_text.length > 100 ? prompt.prompt_text.substring(0, 100) + '...' : prompt.prompt_text;
        lines.push(`**\uD83D\uDCAC User Prompt #${prompt.prompt_number}** (${formatDateTime(item.epoch)})`);
        lines.push(`> ${truncated}`);
        lines.push('');
      } else if (item.type === 'observation') {
        const obs = item.data as ObservationSearchResult;
        const file = extractFirstFile(obs.files_modified, cwd, obs.files_read);

        if (file !== currentFile) {
          if (tableOpen) lines.push('');
          lines.push(`**${file}**`);
          lines.push('| ID | Time | T | Title | Tokens |');
          lines.push('|----|------|---|-------|--------|');
          currentFile = file;
          tableOpen = true;
          lastTime = '';
        }

        const icon = ModeManager.getInstance().getTypeIcon(obs.type);
        const time = formatTime(item.epoch);
        const obsTitle = obs.title || 'Untitled';
        const tokens = estimateTokens(obs.narrative);
        const showTime = time !== lastTime;
        const timeDisplay = showTime ? time : '"';
        lastTime = time;
        const anchorMarker = isAnchor ? ' <- **ANCHOR**' : '';
        lines.push(`| #${obs.id} | ${timeDisplay} | ${icon} | ${obsTitle}${anchorMarker} | ~${tokens} |`);
      }
    }

    if (tableOpen) lines.push('');
  }

  return lines.join('\n');
}

/* ---- Search-result row/header helpers (merged from FormattingService) ---- */

function formatRowTime(epoch: number): string {
  return new Date(epoch).toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function estimateReadTokens(obs: ObservationSearchResult): number {
  const size =
    (obs.title?.length || 0) +
    (obs.subtitle?.length || 0) +
    (obs.narrative?.length || 0) +
    (obs.facts?.length || 0);
  return Math.ceil(size / CHARS_PER_TOKEN_ESTIMATE);
}

export function formatTableHeader(): string {
  return `| ID | Time | T | Title | Read | Work |
|-----|------|---|-------|------|------|`;
}

export function formatSearchTableHeader(): string {
  return `| ID | Time | T | Title | Read |
|----|------|---|-------|------|`;
}

export function formatObservationIndex(obs: ObservationSearchResult): string {
  const id = `#${obs.id}`;
  const time = formatRowTime(obs.created_at_epoch);
  const icon = ModeManager.getInstance().getTypeIcon(obs.type);
  const title = obs.title || 'Untitled';
  const readTokens = estimateReadTokens(obs);
  const workEmoji = ModeManager.getInstance().getWorkEmoji(obs.type);
  const workTokens = obs.discovery_tokens || 0;
  const workDisplay = workTokens > 0 ? `${workEmoji} ${workTokens}` : '-';
  return `| ${id} | ${time} | ${icon} | ${title} | ~${readTokens} | ${workDisplay} |`;
}

export function formatSessionIndex(session: SessionSummarySearchResult): string {
  const id = `#S${session.id}`;
  const time = formatRowTime(session.created_at_epoch);
  const title = session.request || `Session ${session.memory_session_id?.substring(0, 8) || 'unknown'}`;
  return `| ${id} | ${time} | \uD83C\uDFAF | ${title} | - | - |`;
}

export function formatUserPromptIndex(prompt: UserPromptSearchResult): string {
  const id = `#P${prompt.id}`;
  const time = formatRowTime(prompt.created_at_epoch);
  const title = prompt.prompt_text.length > 60 ? prompt.prompt_text.substring(0, 57) + '...' : prompt.prompt_text;
  return `| ${id} | ${time} | \uD83D\uDCAC | ${title} | - | - |`;
}

export function formatObservationSearchRow(obs: ObservationSearchResult, lastTime: string): { row: string; time: string } {
  const id = `#${obs.id}`;
  const time = formatRowTime(obs.created_at_epoch);
  const icon = ModeManager.getInstance().getTypeIcon(obs.type);
  const title = obs.title || 'Untitled';
  const readTokens = estimateReadTokens(obs);
  const timeDisplay = time === lastTime ? '\u2033' : time;
  return { row: `| ${id} | ${timeDisplay} | ${icon} | ${title} | ~${readTokens} |`, time };
}

export function formatSessionSearchRow(session: SessionSummarySearchResult, lastTime: string): { row: string; time: string } {
  const id = `#S${session.id}`;
  const time = formatRowTime(session.created_at_epoch);
  const title = session.request || `Session ${session.memory_session_id?.substring(0, 8) || 'unknown'}`;
  const timeDisplay = time === lastTime ? '\u2033' : time;
  return { row: `| ${id} | ${timeDisplay} | \uD83C\uDFAF | ${title} | - |`, time };
}

export function formatUserPromptSearchRow(prompt: UserPromptSearchResult, lastTime: string): { row: string; time: string } {
  const id = `#P${prompt.id}`;
  const time = formatRowTime(prompt.created_at_epoch);
  const title = prompt.prompt_text.length > 60 ? prompt.prompt_text.substring(0, 57) + '...' : prompt.prompt_text;
  const timeDisplay = time === lastTime ? '\u2033' : time;
  return { row: `| ${id} | ${timeDisplay} | \uD83D\uDCAC | ${title} | - |`, time };
}
