import type { NormalizedItem, RankedItem, ScoringResult, TriageItemType } from "./types.ts";

function rankByType(items: NormalizedItem[], type: TriageItemType): RankedItem[] {
  const ranked = items
    .filter((item) => item.type === type)
    .map((item) => ({
      ...item,
      score: 0,
      rank: 0,
    }))
    .sort((left, right) => {
      const updatedDelta =
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt);

      if (updatedDelta !== 0) {
        return updatedDelta;
      }

      return left.number - right.number;
    });

  return ranked.map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

export function scoreAndRankItems(items: NormalizedItem[]): ScoringResult {
  return {
    issues: rankByType(items, "issue"),
    prs: rankByType(items, "pr"),
  };
}
