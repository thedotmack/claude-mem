/**
 * TimelineService - Handles timeline building, filtering, and formatting
 * Extracted from mcp-server.ts to follow worker service organization pattern
 */

import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../sqlite/types.js';

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

}
