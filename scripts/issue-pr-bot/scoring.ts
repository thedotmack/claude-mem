import type {
  NormalizedItem,
  PriorityBucket,
  RankedItem,
  ScoringResult,
  SeverityBucket,
  TriageItemType,
} from "./types.ts";

export const SEVERITY_BUCKET_ORDER = Object.freeze<SeverityBucket[]>([
  "critical",
  "high",
  "medium",
  "low",
]);
export const PRIORITY_BUCKET_ORDER = Object.freeze<PriorityBucket[]>([
  "urgent",
  "high",
  "normal",
  "low",
]);

export const SEVERITY_BUCKET_WEIGHTS: Record<SeverityBucket, number> =
  Object.freeze({
    critical: 4_000,
    high: 3_000,
    medium: 2_000,
    low: 1_000,
  });
export const PRIORITY_BUCKET_WEIGHTS: Record<PriorityBucket, number> =
  Object.freeze({
    urgent: 400,
    high: 300,
    normal: 200,
    low: 100,
  });

const DEFAULT_SEVERITY_BUCKET: SeverityBucket = "medium";
const DEFAULT_PRIORITY_BUCKET: PriorityBucket = "normal";

function toTimestamp(isoDate: string): number {
  const value = Date.parse(isoDate);
  return Number.isNaN(value) ? 0 : value;
}

function resolveSeverityBucket(_item: NormalizedItem): SeverityBucket {
  return DEFAULT_SEVERITY_BUCKET;
}

function resolvePriorityBucket(_item: NormalizedItem): PriorityBucket {
  return DEFAULT_PRIORITY_BUCKET;
}

function rankByType(items: NormalizedItem[], type: TriageItemType): RankedItem[] {
  const ranked = items
    .filter((item) => item.type === type)
    .map((item) => {
      const severityBucket = resolveSeverityBucket(item);
      const priorityBucket = resolvePriorityBucket(item);

      return {
        ...item,
        score:
          SEVERITY_BUCKET_WEIGHTS[severityBucket] +
          PRIORITY_BUCKET_WEIGHTS[priorityBucket],
        rank: 0,
      };
    })
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      const updatedDelta = toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt);

      if (updatedDelta !== 0) {
        return updatedDelta;
      }

      const createdDelta = toTimestamp(left.createdAt) - toTimestamp(right.createdAt);
      if (createdDelta !== 0) {
        return createdDelta;
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
