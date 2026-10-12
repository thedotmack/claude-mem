
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

    if (typeof anchorId === 'number') {
      const anchorIndex = items.findIndex(item => item.type === 'observation' && (item.data as ObservationSearchResult).id === anchorId);
      if (anchorIndex === -1) return items;
      const startIndex = Math.max(0, anchorIndex - depth_before);
      const endIndex = Math.min(items.length, anchorIndex + depth_after + 1);
      return items.slice(startIndex, endIndex);
    }

    // Session ("S<n>") and timestamp anchors are epoch anchors. storeObservations() stamps a
    // turn's observations and its summary with one epoch, so every item tied at anchorEpoch is
    // the anchor group; depth counts the items strictly before and after that group.
    const before = items.filter(item => item.epoch < anchorEpoch);
    const anchorGroup = items.filter(item => item.epoch === anchorEpoch);
    const after = items.filter(item => item.epoch > anchorEpoch);
    return [
      ...before.slice(Math.max(0, before.length - depth_before)),
      ...anchorGroup,
      ...after.slice(0, depth_after),
    ];
  }
}
