import type {
  CategorizedItem,
  CategoryCluster,
  DuplicateGroup,
  TriageAction,
  TriageConfig,
  TriageRecommendation,
  TriageRecommendationsResult,
} from "./types.ts";

const ACTIVE_WORK_LABEL_KEYWORDS = [
  "in-progress",
  "wip",
  "working",
  "assigned",
  "active",
];

const DEVELOPER_CATEGORY_EXPERTISE: Record<string, CategoryCluster[]> = {
  thedotmack: ["security", "hooks", "installation"],
  glucksberg: ["chroma", "process-lifecycle"],
  bigph00t: ["windows", "feature-request"],
};

function hasActiveWorkLabels(item: CategorizedItem): boolean {
  return item.labels.some((label) =>
    ACTIVE_WORK_LABEL_KEYWORDS.some((keyword) =>
      label.name.toLowerCase().includes(keyword)
    )
  );
}

function daysSinceUpdate(item: CategorizedItem, nowTimestamp: number): number {
  const updatedTimestamp = Date.parse(item.updatedAt);
  if (Number.isNaN(updatedTimestamp)) {
    return 0;
  }
  return Math.floor((nowTimestamp - updatedTimestamp) / (1000 * 60 * 60 * 24));
}

function findDeveloperForCategory(
  category: CategoryCluster,
  developerPriorityOrder: string[]
): string {
  for (const [developer, categories] of Object.entries(DEVELOPER_CATEGORY_EXPERTISE)) {
    if (categories.includes(category)) {
      return developer;
    }
  }
  // Default to first developer in priority order (core maintainer)
  return developerPriorityOrder[0] ?? "thedotmack";
}

export function generateRecommendations(
  categorized: CategorizedItem[],
  duplicateGroups: DuplicateGroup[],
  config: TriageConfig
): TriageRecommendationsResult {
  const recommendations: TriageRecommendation[] = [];
  const itemsWithRecommendations = new Set<number>();
  const nowTimestamp = Date.parse(config.generatedAt) || Date.now();

  // Phase 1: Spam detection
  for (const item of categorized) {
    if (item.category === "spam") {
      recommendations.push({
        itemNumber: item.number,
        action: "close-spam",
        reason: "Item categorized as spam based on content analysis",
      });
      itemsWithRecommendations.add(item.number);
    }
  }

  // Phase 2: Outdated detection
  for (const item of categorized) {
    if (itemsWithRecommendations.has(item.number)) {
      continue;
    }

    const inactivityDays = daysSinceUpdate(item, nowTimestamp);
    if (
      inactivityDays >= config.discovery.outdatedThresholdDays &&
      !hasActiveWorkLabels(item)
    ) {
      recommendations.push({
        itemNumber: item.number,
        action: "close-outdated",
        reason: `No updates for ${inactivityDays} days and no active work labels`,
      });
      itemsWithRecommendations.add(item.number);
    }
  }

  // Phase 3: Duplicate handling
  for (const group of duplicateGroups) {
    // Non-canonical items get close-duplicate
    for (const duplicateNumber of group.duplicates) {
      if (!itemsWithRecommendations.has(duplicateNumber)) {
        recommendations.push({
          itemNumber: duplicateNumber,
          action: "close-duplicate",
          reason: `Duplicate of #${group.canonical} (${group.reason})`,
          targetIssue: group.canonical,
        });
        itemsWithRecommendations.add(duplicateNumber);
      }
    }

    // Canonical gets merge-into-tracking if 3+ items in group
    const totalGroupSize = group.duplicates.length + 1;
    if (
      totalGroupSize >= 3 &&
      !itemsWithRecommendations.has(group.canonical)
    ) {
      recommendations.push({
        itemNumber: group.canonical,
        action: "merge-into-tracking",
        reason: `Group has ${totalGroupSize} related items — consolidate into tracking issue`,
      });
      itemsWithRecommendations.add(group.canonical);
    }
  }

  // Phase 4: PR-specific recommendations
  for (const item of categorized) {
    if (itemsWithRecommendations.has(item.number)) {
      continue;
    }
    if (item.type !== "pr") {
      continue;
    }

    if (item.mergeableState === "CONFLICTING") {
      recommendations.push({
        itemNumber: item.number,
        action: "needs-rebase",
        reason: "PR has merge conflicts that need resolution",
      });
      itemsWithRecommendations.add(item.number);
      continue;
    }

    if (
      item.mergeableState === "MERGEABLE" &&
      item.reviewDecision === "APPROVED"
    ) {
      recommendations.push({
        itemNumber: item.number,
        action: "ready-to-merge",
        reason: "PR is approved and mergeable",
      });
      itemsWithRecommendations.add(item.number);
      continue;
    }
  }

  // Phase 5: Developer assignment for remaining items
  for (const item of categorized) {
    if (itemsWithRecommendations.has(item.number)) {
      continue;
    }

    const developer = findDeveloperForCategory(
      item.category,
      config.developerPriorityOrder
    );
    recommendations.push({
      itemNumber: item.number,
      action: "assign-developer",
      reason: `Category "${item.category}" maps to ${developer}`,
      assignTo: developer,
    });
    itemsWithRecommendations.add(item.number);
  }

  // Build derived collections
  const closeCandidates = recommendations.filter(
    (recommendation) =>
      recommendation.action === "close-outdated" ||
      recommendation.action === "close-duplicate" ||
      recommendation.action === "close-spam"
  );

  const mergeCandidates = recommendations.filter(
    (recommendation) => recommendation.action === "merge-into-tracking"
  );

  const assignmentMap: Record<string, number[]> = {};
  for (const recommendation of recommendations) {
    if (recommendation.action === "assign-developer" && recommendation.assignTo) {
      const existing = assignmentMap[recommendation.assignTo] ?? [];
      existing.push(recommendation.itemNumber);
      assignmentMap[recommendation.assignTo] = existing;
    }
  }

  return {
    recommendations,
    closeCandidates,
    mergeCandidates,
    assignmentMap,
  };
}
