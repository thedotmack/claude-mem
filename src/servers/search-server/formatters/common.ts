/**
 * Timeline item for unified chronological display
 */
export interface TimelineItem {
  type: 'observation' | 'session' | 'prompt';
  data: any;
  epoch: number;
}

export function formatSearchTips(): string {
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
 * Filter timeline items to respect depth_before/depth_after window around anchor
 */
export function filterTimelineByDepth(
  items: TimelineItem[],
  anchorId: number | string,
  anchorEpoch: number,
  depth_before: number,
  depth_after: number
): TimelineItem[] {
  if (items.length === 0) return items;

  let anchorIndex = -1;
  if (typeof anchorId === 'number') {
    anchorIndex = items.findIndex(item => item.type === 'observation' && item.data.id === anchorId);
  } else if (typeof anchorId === 'string' && anchorId.startsWith('S')) {
    const sessionNum = parseInt(anchorId.slice(1), 10);
    anchorIndex = items.findIndex(item => item.type === 'session' && item.data.id === sessionNum);
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
