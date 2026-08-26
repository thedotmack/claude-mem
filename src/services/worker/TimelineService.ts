
import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../sqlite/types.js';

export interface TimelineItem {
  type: 'observation' | 'session' | 'prompt';
  data: ObservationSearchResult | SessionSummarySearchResult | UserPromptSearchResult;
  epoch: number;
}

export class TimelineService {
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
      anchorIndex = items.findIndex(item => item.epoch >= anchorEpoch);
      if (anchorIndex === -1) anchorIndex = items.length - 1;
    }

    if (anchorIndex === -1) return items;

    const startIndex = Math.max(0, anchorIndex - depth_before);
    const endIndex = Math.min(items.length, anchorIndex + depth_after + 1);
    return items.slice(startIndex, endIndex);
  }
}
