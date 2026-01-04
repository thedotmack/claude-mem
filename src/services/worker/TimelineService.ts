/**
 * TimelineService - Handles timeline building, filtering, and formatting
 * Extracted from mcp-server.ts to follow worker service organization pattern
 */

import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../sqlite/types.js';
import { ModeManager } from '../domain/ModeManager.js';
import { logger } from '../../utils/logger.js';

/**
 * Timeline item for unified chronological display
 */
export interface TimelineItem {
  type: 'observation' | 'session' | 'prompt';
  data: ObservationSearchResult | SessionSummarySearchResult | UserPromptSearchResult;
  epoch: number;
}

export interface TimelineData {
  observations: ObservationSearchResult[];
  sessions: SessionSummarySearchResult[];
  prompts: UserPromptSearchResult[];
}

export class TimelineService {
  /**
   * Build timeline items from observations, sessions, and prompts
   */
  buildTimeline(data: TimelineData): TimelineItem[] {
    const items: TimelineItem[] = [
      ...data.observations.map(obs => ({ type: 'observation' as const, data: obs, epoch: obs.created_at_epoch })),
      ...data.sessions.map(sess => ({ type: 'session' as const, data: sess, epoch: sess.created_at_epoch })),
      ...data.prompts.map(prompt => ({ type: 'prompt' as const, data: prompt, epoch: prompt.created_at_epoch }))
    ];
    items.sort((a, b) => a.epoch - b.epoch);
    return items;
  }

  /**
   * Filter timeline items to respect depth_before/depth_after window around anchor
   */
  filterByDepth(
    items: TimelineItem[],
    anchorId: number | string,
    anchorEpoch: number,
    depth_before: number,
    depth_after: number
  ): TimelineItem[] {
    if (items.length === 0) return items;

    let anchorIndex = -1;
    if (typeof anchorId === 'number') {
      anchorIndex = items.findIndex(item => item.type === 'observation' && (item.data as ObservationSearchResult).id === anchorId);
    } else if (typeof anchorId === 'string' && anchorId.startsWith('S')) {
      const sessionNum = parseInt(anchorId.slice(1), 10);
      anchorIndex = items.findIndex(item => item.type === 'session' && (item.data as SessionSummarySearchResult).id === sessionNum);
    } else {
      // Timestamp anchor - find closest item
      anchorIndex = items.findIndex(item => item.epoch >= anchorEpoch);
      if (anchorIndex === -1) anchorIndex = items.length - 1;
    }

    if (anchorIndex === -1) return items;

    const startIndex = Math.max(0, anchorIndex - depth_before);
    const endIndex = Math.min(items.length, anchorIndex + depth_after + 1);
    return items.slice(startIndex, endIndex);
  }

  /**
   * Format timeline items as markdown with grouped days and tables
   */
  formatTimeline(
    items: TimelineItem[],
    anchorId: number | string | null,
    query?: string,
    depth_before?: number,
    depth_after?: number
  ): string {
    if (items.length === 0) {
      return query
        ? `Found observation matching "${query}", but no timeline context available.`
        : 'No timeline items found';
    }

    const lines: string[] = [];

    // Header
    if (query && anchorId) {
      const anchorObs = items.find(item => item.type === 'observation' && (item.data as ObservationSearchResult).id === anchorId);
      const anchorTitle = anchorObs ? ((anchorObs.data as ObservationSearchResult).title || 'Untitled') : 'Unknown';
      lines.push(`# Timeline for query: "${query}"`);
      lines.push(`**Anchor:** Observation #${anchorId} - ${anchorTitle}`);
    } else if (anchorId) {
      lines.push(`# Timeline around anchor: ${anchorId}`);
    } else {
      lines.push(`# Timeline`);
    }

    if (depth_before !== undefined && depth_after !== undefined) {
      lines.push(`**Window:** ${depth_before} records before → ${depth_after} records after | **Items:** ${items.length}`);
    } else {
      lines.push(`**Items:** ${items.length}`);
    }
    lines.push('');

    // Legend
    lines.push(`**Legend:** 🎯 session-request | 🔴 bugfix | 🟣 feature | 🔄 refactor | ✅ change | 🔵 discovery | 🧠 decision`);
    lines.push('');

    // Group by day
    const dayMap = new Map<string, TimelineItem[]>();
    for (const item of items) {
      const day = this.formatDate(item.epoch);
      if (!dayMap.has(day)) {
        dayMap.set(day, []);
      }
      dayMap.get(day)!.push(item);
    }

    // Sort days chronologically
    const sortedDays = Array.from(dayMap.entries()).sort((a, b) => {
      const aDate = new Date(a[0]).getTime();
      const bDate = new Date(b[0]).getTime();
      return aDate - bDate;
    });

    // Render each day
    for (const [day, dayItems] of sortedDays) {
      lines.push(`### ${day}`);
      lines.push('');

      let currentFile: string | null = null;
      let lastTime = '';
      let tableOpen = false;

      for (const item of dayItems) {
        const isAnchor = (
          (typeof anchorId === 'number' && item.type === 'observation' && (item.data as ObservationSearchResult).id === anchorId) ||
          (typeof anchorId === 'string' && anchorId.startsWith('S') && item.type === 'session' && `S${(item.data as SessionSummarySearchResult).id}` === anchorId)
        );

        if (item.type === 'session') {
          if (tableOpen) {
            lines.push('');
            tableOpen = false;
            currentFile = null;
            lastTime = '';
          }

          const sess = item.data as SessionSummarySearchResult;
          const title = sess.request || 'Session summary';
          const marker = isAnchor ? ' ← **ANCHOR**' : '';

          lines.push(`**🎯 #S${sess.id}** ${title} (${this.formatDateTime(item.epoch)})${marker}`);
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

          lines.push(`**💬 User Prompt #${prompt.prompt_number}** (${this.formatDateTime(item.epoch)})`);
          lines.push(`> ${truncated}`);
          lines.push('');
        } else if (item.type === 'observation') {
          const obs = item.data as ObservationSearchResult;
          const file = 'General';

          if (file !== currentFile) {
            if (tableOpen) {
              lines.push('');
            }

            lines.push(`**${file}**`);
            lines.push(`| ID | Time | T | Title | Tokens |`);
            lines.push(`|----|------|---|-------|--------|`);

            currentFile = file;
            tableOpen = true;
            lastTime = '';
          }

          const icon = this.getTypeIcon(obs.type);
          const time = this.formatTime(item.epoch);
          const title = obs.title || 'Untitled';
          const tokens = this.estimateTokens(obs.narrative);

          const showTime = time !== lastTime;
          const timeDisplay = showTime ? time : '″';
          lastTime = time;

          const anchorMarker = isAnchor ? ' ← **ANCHOR**' : '';
          lines.push(`| #${obs.id} | ${timeDisplay} | ${icon} | ${title}${anchorMarker} | ~${tokens} |`);
        }
      }

      if (tableOpen) {
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Get icon for observation type
   */
  private getTypeIcon(type: string): string {
    return ModeManager.getInstance().getTypeIcon(type);
  }

  /**
   * Format date for grouping (e.g., "Dec 7, 2025")
   */
  private formatDate(epochMs: number): string {
    const date = new Date(epochMs);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  /**
   * Format time (e.g., "6:30 PM")
   */
  private formatTime(epochMs: number): string {
    const date = new Date(epochMs);
    return date.toLocaleString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }

  /**
   * Format date and time (e.g., "Dec 7, 6:30 PM")
   */
  private formatDateTime(epochMs: number): string {
    const date = new Date(epochMs);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }

  /**
   * Estimate tokens from text length (~4 chars per token)
   */
  private estimateTokens(text: string | null): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }
}
