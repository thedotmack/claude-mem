import { describe, expect, it } from "bun:test";

import {
  categorizeItem,
  categorizeItems,
} from "../../../scripts/issue-pr-bot/categorizer.ts";
import type { NormalizedItem, TriageItemType } from "../../../scripts/issue-pr-bot/types.ts";

function buildItem(
  number: number,
  type: TriageItemType,
  {
    title,
    body = "",
    labels = [],
  }: {
    title: string;
    body?: string;
    labels?: string[];
  }
): NormalizedItem {
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
    labels: labels.map((name) => ({ name })),
    assignees: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-18T00:00:00.000Z",
    pullRequest: null,
  };
}

describe("categorizeItem", () => {
  it("categorizes 'ChromaDB crashes on startup' as chroma", () => {
    const item = buildItem(1, "issue", {
      title: "ChromaDB crashes on startup",
    });
    expect(categorizeItem(item)).toBe("chroma");
  });

  it("categorizes 'zombie process after session end' as process-lifecycle", () => {
    const item = buildItem(2, "issue", {
      title: "zombie process after session end",
    });
    expect(categorizeItem(item)).toBe("process-lifecycle");
  });

  it("categorizes item with enhancement label and generic title as feature-request", () => {
    const item = buildItem(3, "issue", {
      title: "Add dark mode",
      labels: ["enhancement"],
    });
    expect(categorizeItem(item)).toBe("feature-request");
  });

  it("security keywords override other matches (priority ordering)", () => {
    const item = buildItem(4, "issue", {
      title: "Security vulnerability in worker process",
      body: "The worker process has a security injection flaw",
    });
    expect(categorizeItem(item)).toBe("security");
  });

  it("categorizes very short title with empty body as spam", () => {
    const item = buildItem(5, "issue", {
      title: "Hhh",
      body: "",
      labels: [],
    });
    expect(categorizeItem(item)).toBe("spam");
  });

  it("categorizes unmatched item as uncategorized", () => {
    const item = buildItem(6, "issue", {
      title: "Something completely random and long enough",
      body: "No keywords match here at all.",
    });
    expect(categorizeItem(item)).toBe("uncategorized");
  });

  it("categorizes windows-related items correctly", () => {
    const item = buildItem(7, "issue", {
      title: "WMIC removal breaks detection on Windows",
    });
    expect(categorizeItem(item)).toBe("windows");
  });

  it("categorizes hook-related items correctly", () => {
    const item = buildItem(8, "issue", {
      title: "SessionStart hook blocks for 10 seconds",
    });
    expect(categorizeItem(item)).toBe("hooks");
  });

  it("categorizes installation-related items correctly", () => {
    const item = buildItem(9, "issue", {
      title: "marketplace path mismatch after install",
    });
    expect(categorizeItem(item)).toBe("installation");
  });
});

describe("categorizeItems", () => {
  it("maps all items through categorizer", () => {
    const items = [
      buildItem(10, "issue", { title: "ChromaDB segfault" }),
      buildItem(11, "issue", { title: "zombie daemon leak" }),
      buildItem(12, "issue", { title: "Something random and long enough for uncategorized" }),
    ];

    const categorized = categorizeItems(items);
    expect(categorized).toHaveLength(3);
    expect(categorized[0].category).toBe("chroma");
    expect(categorized[1].category).toBe("process-lifecycle");
    expect(categorized[2].category).toBe("uncategorized");
    // Verify the original fields are preserved
    expect(categorized[0].number).toBe(10);
    expect(categorized[1].title).toBe("zombie daemon leak");
  });
});
