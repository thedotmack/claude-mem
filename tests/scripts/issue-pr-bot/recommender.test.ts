import { describe, expect, it } from "bun:test";

import { generateRecommendations } from "../../../scripts/issue-pr-bot/recommender.ts";
import type {
  CategorizedItem,
  CategoryCluster,
  DuplicateGroup,
  TriageConfig,
  TriageItemType,
} from "../../../scripts/issue-pr-bot/types.ts";

const NOW_ISO = "2026-02-19T00:00:00.000Z";

function buildConfig(overrides: Partial<TriageConfig> = {}): TriageConfig {
  return {
    repository: { owner: "test", repo: "repo" },
    discovery: {
      scope: "open-issues-and-prs",
      outdatedThresholdDays: 90,
    },
    output: { sections: ["issues", "prs"] },
    developerPriorityOrder: ["thedotmack", "bigph00t", "glucksberg"],
    generatedAt: NOW_ISO,
    ...overrides,
  };
}

function buildCategorizedItem(
  number: number,
  type: TriageItemType,
  category: CategoryCluster,
  {
    updatedAt = "2026-02-18T00:00:00.000Z",
    labels = [] as string[],
    mergeableState,
    reviewDecision,
  }: {
    updatedAt?: string;
    labels?: string[];
    mergeableState?: string;
    reviewDecision?: string;
  } = {}
): CategorizedItem {
  return {
    id: number,
    number,
    type,
    title: `Test item #${number}`,
    body: "",
    links: {
      html: `https://github.com/test/repo/issues/${number}`,
      api: `https://api.github.com/repos/test/repo/issues/${number}`,
    },
    htmlUrl: `https://github.com/test/repo/issues/${number}`,
    author: { login: "contributor" },
    labels: labels.map((name) => ({ name })),
    assignees: [],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt,
    pullRequest: type === "pr" ? { changedFiles: 5, additions: 100, deletions: 50, commits: 2 } : null,
    category,
    mergeableState,
    reviewDecision,
  };
}

describe("generateRecommendations", () => {
  it("flags item updated 100 days ago with no active labels as close-outdated", () => {
    // 100 days before NOW_ISO
    const outdatedDate = new Date(Date.parse(NOW_ISO) - 100 * 24 * 60 * 60 * 1000).toISOString();
    const items = [
      buildCategorizedItem(1, "issue", "hooks", { updatedAt: outdatedDate }),
    ];

    const result = generateRecommendations(items, [], buildConfig());

    const recommendation = result.recommendations.find((r) => r.itemNumber === 1);
    expect(recommendation).toBeDefined();
    expect(recommendation!.action).toBe("close-outdated");
    expect(result.closeCandidates).toHaveLength(1);
  });

  it("does NOT flag item updated 30 days ago as outdated", () => {
    const recentDate = new Date(Date.parse(NOW_ISO) - 30 * 24 * 60 * 60 * 1000).toISOString();
    const items = [
      buildCategorizedItem(2, "issue", "hooks", { updatedAt: recentDate }),
    ];

    const result = generateRecommendations(items, [], buildConfig());

    const recommendation = result.recommendations.find((r) => r.itemNumber === 2);
    expect(recommendation).toBeDefined();
    // Should be assigned to a developer, not closed
    expect(recommendation!.action).toBe("assign-developer");
  });

  it("flags spam-categorized items as close-spam", () => {
    const items = [
      buildCategorizedItem(3, "issue", "spam"),
    ];

    const result = generateRecommendations(items, [], buildConfig());

    const recommendation = result.recommendations.find((r) => r.itemNumber === 3);
    expect(recommendation).toBeDefined();
    expect(recommendation!.action).toBe("close-spam");
    expect(result.closeCandidates).toHaveLength(1);
  });

  it("flags duplicate group non-canonical items as close-duplicate with correct targetIssue", () => {
    const items = [
      buildCategorizedItem(10, "issue", "chroma"),
      buildCategorizedItem(11, "issue", "chroma"),
    ];
    const duplicateGroups: DuplicateGroup[] = [
      { groupId: 1, canonical: 10, duplicates: [11], reason: "title-similarity (0.80)" },
    ];

    const result = generateRecommendations(items, duplicateGroups, buildConfig());

    const closeDup = result.recommendations.find(
      (r) => r.itemNumber === 11 && r.action === "close-duplicate"
    );
    expect(closeDup).toBeDefined();
    expect(closeDup!.targetIssue).toBe(10);
    expect(result.closeCandidates.some((r) => r.itemNumber === 11)).toBe(true);
  });

  it("flags canonical item as merge-into-tracking when group has 3+ items", () => {
    const items = [
      buildCategorizedItem(20, "issue", "windows"),
      buildCategorizedItem(21, "issue", "windows"),
      buildCategorizedItem(22, "issue", "windows"),
    ];
    const duplicateGroups: DuplicateGroup[] = [
      { groupId: 1, canonical: 20, duplicates: [21, 22], reason: "title-similarity (0.70)" },
    ];

    const result = generateRecommendations(items, duplicateGroups, buildConfig());

    const mergeRec = result.recommendations.find(
      (r) => r.itemNumber === 20 && r.action === "merge-into-tracking"
    );
    expect(mergeRec).toBeDefined();
    expect(result.mergeCandidates).toHaveLength(1);
  });

  it("flags PR with CONFLICTING mergeableState as needs-rebase", () => {
    const items = [
      buildCategorizedItem(30, "pr", "hooks", {
        mergeableState: "CONFLICTING",
      }),
    ];

    const result = generateRecommendations(items, [], buildConfig());

    const recommendation = result.recommendations.find((r) => r.itemNumber === 30);
    expect(recommendation).toBeDefined();
    expect(recommendation!.action).toBe("needs-rebase");
  });

  it("follows category mapping for developer assignment", () => {
    const items = [
      buildCategorizedItem(40, "issue", "security"),
      buildCategorizedItem(41, "issue", "chroma"),
      buildCategorizedItem(42, "issue", "windows"),
    ];

    const result = generateRecommendations(items, [], buildConfig());

    const securityRec = result.recommendations.find((r) => r.itemNumber === 40);
    expect(securityRec).toBeDefined();
    expect(securityRec!.action).toBe("assign-developer");
    expect(securityRec!.assignTo).toBe("thedotmack");

    const chromaRec = result.recommendations.find((r) => r.itemNumber === 41);
    expect(chromaRec).toBeDefined();
    expect(chromaRec!.assignTo).toBe("glucksberg");

    const windowsRec = result.recommendations.find((r) => r.itemNumber === 42);
    expect(windowsRec).toBeDefined();
    expect(windowsRec!.assignTo).toBe("bigph00t");

    expect(result.assignmentMap["thedotmack"]).toContain(40);
    expect(result.assignmentMap["glucksberg"]).toContain(41);
    expect(result.assignmentMap["bigph00t"]).toContain(42);
  });

  it("does not reassign items that already have close/merge recommendations", () => {
    // Item is spam (close-spam) AND in a duplicate group — should only get close-spam, not reassigned
    const items = [
      buildCategorizedItem(50, "issue", "spam"),
      buildCategorizedItem(51, "issue", "chroma"),
    ];
    const duplicateGroups: DuplicateGroup[] = [
      { groupId: 1, canonical: 51, duplicates: [50], reason: "shared-issue-reference" },
    ];

    const result = generateRecommendations(items, duplicateGroups, buildConfig());

    // Item 50 gets close-spam (phase 1 runs before phase 3)
    const spamRec = result.recommendations.filter((r) => r.itemNumber === 50);
    expect(spamRec).toHaveLength(1);
    expect(spamRec[0].action).toBe("close-spam");

    // Item 51 is canonical, group has 2 members (< 3) so no merge-into-tracking
    // It should get assign-developer
    const canonicalRec = result.recommendations.filter((r) => r.itemNumber === 51);
    expect(canonicalRec).toHaveLength(1);
    expect(canonicalRec[0].action).toBe("assign-developer");
  });
});
