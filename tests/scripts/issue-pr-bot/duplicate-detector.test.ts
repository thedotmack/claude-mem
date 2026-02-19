import { describe, expect, it } from "bun:test";

import { detectDuplicates } from "../../../scripts/issue-pr-bot/duplicate-detector.ts";
import type {
  CategorizedItem,
  CategoryCluster,
  TriageItemType,
} from "../../../scripts/issue-pr-bot/types.ts";

function buildCategorizedItem(
  number: number,
  type: TriageItemType,
  category: CategoryCluster,
  {
    title,
    body = "",
    createdAt = "2026-01-01T00:00:00.000Z",
  }: {
    title: string;
    body?: string;
    createdAt?: string;
  }
): CategorizedItem {
  return {
    id: number,
    number,
    type,
    title,
    body,
    links: {
      html: `https://github.com/test/repo/issues/${number}`,
      api: `https://api.github.com/repos/test/repo/issues/${number}`,
    },
    htmlUrl: `https://github.com/test/repo/issues/${number}`,
    author: { login: "contributor" },
    labels: [],
    assignees: [],
    createdAt,
    updatedAt: "2026-02-18T00:00:00.000Z",
    pullRequest: null,
    category,
  };
}

describe("detectDuplicates", () => {
  it("groups items with similar titles in the same category", () => {
    const items: CategorizedItem[] = [
      buildCategorizedItem(1, "issue", "process-lifecycle", {
        title: "zombie process leak",
      }),
      buildCategorizedItem(2, "issue", "process-lifecycle", {
        title: "zombie process left running",
      }),
    ];

    const groups = detectDuplicates(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].duplicates).toHaveLength(1);
    // Both items should be in the same group
    const allNumbers = [groups[0].canonical, ...groups[0].duplicates].sort();
    expect(allNumbers).toEqual([1, 2]);
  });

  it("does NOT group items in different categories even with similar titles", () => {
    const items: CategorizedItem[] = [
      buildCategorizedItem(3, "issue", "process-lifecycle", {
        title: "process crash on startup",
      }),
      buildCategorizedItem(4, "issue", "chroma", {
        title: "process crash on startup with chroma",
      }),
    ];

    const groups = detectDuplicates(items);
    expect(groups).toHaveLength(0);
  });

  it("groups items referencing the same issue number in body", () => {
    const items: CategorizedItem[] = [
      buildCategorizedItem(5, "issue", "hooks", {
        title: "SessionStart hook hangs",
        body: "Related to #100 and #200",
      }),
      buildCategorizedItem(6, "issue", "hooks", {
        title: "PostToolUse cascade failure",
        body: "See #100 for context",
      }),
    ];

    const groups = detectDuplicates(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toContain("shared-issue-reference");
  });

  it("makes the oldest item canonical", () => {
    const items: CategorizedItem[] = [
      buildCategorizedItem(10, "issue", "windows", {
        title: "WMIC removal breaks detection",
        createdAt: "2026-02-01T00:00:00.000Z",
      }),
      buildCategorizedItem(11, "issue", "windows", {
        title: "WMIC removal breaks detection on Windows",
        createdAt: "2026-01-15T00:00:00.000Z",
      }),
    ];

    const groups = detectDuplicates(items);
    expect(groups).toHaveLength(1);
    // Item 11 is older, so it should be canonical
    expect(groups[0].canonical).toBe(11);
    expect(groups[0].duplicates).toEqual([10]);
  });

  it("does not group items with low Jaccard similarity", () => {
    const items: CategorizedItem[] = [
      buildCategorizedItem(20, "issue", "chroma", {
        title: "ChromaDB embedding backfill fails on large datasets",
      }),
      buildCategorizedItem(21, "issue", "chroma", {
        title: "Vector search returns empty results for new observations",
      }),
    ];

    const groups = detectDuplicates(items);
    expect(groups).toHaveLength(0);
  });

  it("returns groups sorted by size descending", () => {
    const items: CategorizedItem[] = [
      // Small group (2 items)
      buildCategorizedItem(30, "issue", "hooks", {
        title: "hook timeout issue alpha",
      }),
      buildCategorizedItem(31, "issue", "hooks", {
        title: "hook timeout issue beta",
      }),
      // Larger group (3 items via shared references)
      buildCategorizedItem(40, "issue", "chroma", {
        title: "chroma crash scenario A",
        body: "See #999",
      }),
      buildCategorizedItem(41, "issue", "chroma", {
        title: "chroma crash scenario B",
        body: "Related to #999",
      }),
      buildCategorizedItem(42, "issue", "chroma", {
        title: "chroma crash scenario C",
        body: "Duplicate of #999",
      }),
    ];

    const groups = detectDuplicates(items);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    // First group should be the larger one
    expect(groups[0].duplicates.length).toBeGreaterThanOrEqual(groups[1].duplicates.length);
  });
});
