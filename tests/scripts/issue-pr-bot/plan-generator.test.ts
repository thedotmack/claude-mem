import { describe, expect, it } from "bun:test";

import { generateActionPlans } from "../../../scripts/issue-pr-bot/plan-generator.ts";
import type {
  CategorizedItem,
  CategoryCluster,
  TriageConfig,
  TriageItemType,
  TriageRecommendation,
  TriageRecommendationsResult,
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
    body = "",
    title,
    labels = [] as string[],
    mergeableState,
    reviewDecision,
  }: {
    body?: string;
    title?: string;
    labels?: string[];
    mergeableState?: string;
    reviewDecision?: string;
  } = {}
): CategorizedItem {
  return {
    id: number,
    number,
    type,
    title: title ?? `Test item #${number}`,
    body,
    links: {
      html: `https://github.com/test/repo/issues/${number}`,
      api: `https://api.github.com/repos/test/repo/issues/${number}`,
    },
    htmlUrl: `https://github.com/test/repo/issues/${number}`,
    author: { login: "contributor" },
    labels: labels.map((name) => ({ name })),
    assignees: [],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2026-02-18T00:00:00.000Z",
    pullRequest:
      type === "pr"
        ? { changedFiles: 5, additions: 100, deletions: 50, commits: 2 }
        : null,
    category,
    mergeableState,
    reviewDecision,
  };
}

function buildRecommendations(
  recommendations: TriageRecommendation[]
): TriageRecommendationsResult {
  return {
    recommendations,
    closeCandidates: recommendations.filter((r) =>
      ["close-outdated", "close-duplicate", "close-spam"].includes(r.action)
    ),
    mergeCandidates: recommendations.filter(
      (r) => r.action === "merge-into-tracking"
    ),
    assignmentMap: {},
  };
}

describe("generateActionPlans", () => {
  it("excludes items with close recommendations from plans", () => {
    const items = [
      buildCategorizedItem(1, "issue", "hooks"),
      buildCategorizedItem(2, "issue", "chroma", {
        title: "ChromaDB connection pooling issue",
      }),
      buildCategorizedItem(3, "issue", "spam"),
    ];
    const recommendations = buildRecommendations([
      { itemNumber: 1, action: "close-outdated", reason: "stale" },
      {
        itemNumber: 2,
        action: "assign-developer",
        reason: "active",
        assignTo: "thedotmack",
      },
      { itemNumber: 3, action: "close-spam", reason: "spam" },
    ]);

    const result = generateActionPlans(items, recommendations, buildConfig());

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].itemNumber).toBe(2);
  });

  it("assigns correct likelyFiles for chroma-categorized bug", () => {
    const items = [
      buildCategorizedItem(10, "issue", "chroma", {
        title: "ChromaDB crashes on startup",
      }),
    ];
    const recommendations = buildRecommendations([
      {
        itemNumber: 10,
        action: "assign-developer",
        reason: "chroma",
        assignTo: "glucksberg",
      },
    ]);

    const result = generateActionPlans(items, recommendations, buildConfig());

    expect(result.plans[0].likelyFiles).toEqual([
      "src/services/sync/ChromaSync.ts",
      "src/services/chroma/",
    ]);
  });

  it("assigns estimatedEffort 'large' for critical severity item", () => {
    // "security vulnerability" triggers critical severity in scoring.ts
    const items = [
      buildCategorizedItem(20, "issue", "security", {
        title: "Security vulnerability in API endpoint",
        labels: ["security"],
      }),
    ];
    const recommendations = buildRecommendations([
      {
        itemNumber: 20,
        action: "assign-developer",
        reason: "security",
        assignTo: "thedotmack",
      },
    ]);

    const result = generateActionPlans(items, recommendations, buildConfig());

    expect(result.plans[0].estimatedEffort).toBe("large");
    expect(result.plans[0].severity).toBe("critical");
  });

  it("generates merge/rebase-specific nextStep for PR items", () => {
    const rebaseItem = buildCategorizedItem(30, "pr", "hooks", {
      mergeableState: "CONFLICTING",
    });
    const mergeItem = buildCategorizedItem(31, "pr", "hooks", {
      mergeableState: "MERGEABLE",
      reviewDecision: "APPROVED",
    });
    const items = [rebaseItem, mergeItem];
    const recommendations = buildRecommendations([
      { itemNumber: 30, action: "needs-rebase", reason: "conflicts" },
      { itemNumber: 31, action: "ready-to-merge", reason: "approved" },
    ]);

    const result = generateActionPlans(items, recommendations, buildConfig());

    const rebasePlan = result.plans.find((p) => p.itemNumber === 30);
    expect(rebasePlan!.nextStep).toBe(
      "Rebase onto main, resolve conflicts, re-run tests"
    );

    const mergePlan = result.plans.find((p) => p.itemNumber === 31);
    expect(mergePlan!.nextStep).toBe(
      "Review final changes, merge, verify in production"
    );
  });

  it("groups plans correctly by developer, category, and severity", () => {
    const items = [
      buildCategorizedItem(40, "issue", "chroma", {
        title: "ChromaDB leaking connections",
      }),
      buildCategorizedItem(41, "issue", "security", {
        title: "Security vulnerability in auth",
        labels: ["security"],
      }),
      buildCategorizedItem(42, "issue", "chroma", {
        title: "Chroma config setting unclear",
        labels: ["enhancement"],
      }),
    ];
    const recommendations = buildRecommendations([
      {
        itemNumber: 40,
        action: "assign-developer",
        reason: "chroma",
        assignTo: "glucksberg",
      },
      {
        itemNumber: 41,
        action: "assign-developer",
        reason: "security",
        assignTo: "thedotmack",
      },
      {
        itemNumber: 42,
        action: "assign-developer",
        reason: "chroma",
        assignTo: "glucksberg",
      },
    ]);

    const result = generateActionPlans(items, recommendations, buildConfig());

    expect(result.plans).toHaveLength(3);

    // by developer
    expect(result.byDeveloper["glucksberg"]).toHaveLength(2);
    expect(result.byDeveloper["thedotmack"]).toHaveLength(1);

    // by category
    expect(result.byCategory["chroma"]).toHaveLength(2);
    expect(result.byCategory["security"]).toHaveLength(1);

    // by severity — at least verify the groups exist
    const allSeverityKeys = Object.keys(result.bySeverity);
    expect(allSeverityKeys.length).toBeGreaterThan(0);
    const totalPlansInSeverityGroups = Object.values(result.bySeverity).reduce(
      (sum, plans) => sum + plans.length,
      0
    );
    expect(totalPlansInSeverityGroups).toBe(3);
  });

  it("defaults assignedTo to 'unassigned' when no assignTo recommendation exists", () => {
    const items = [
      buildCategorizedItem(50, "issue", "uncategorized", {
        title: "Some random issue that is long enough",
      }),
    ];
    const recommendations = buildRecommendations([
      { itemNumber: 50, action: "keep-as-is", reason: "no action needed" },
    ]);

    const result = generateActionPlans(items, recommendations, buildConfig());

    expect(result.plans[0].assignedTo).toBe("unassigned");
  });
});
