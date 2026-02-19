import { describe, expect, it } from "bun:test";

import {
  DEFAULT_DEVELOPER_PRIORITY_ORDER,
  DEFAULT_OUTDATED_THRESHOLD_DAYS,
} from "../../../scripts/issue-pr-bot/config.ts";
import { scoreAndRankItems } from "../../../scripts/issue-pr-bot/scoring.ts";
import type { NormalizedItem, TriageItemType } from "../../../scripts/issue-pr-bot/types.ts";

const NOW = "2026-02-19T00:00:00.000Z";

function buildItem(
  number: number,
  type: TriageItemType,
  {
    title,
    body = "",
    labels = [],
    author = "contributor",
    updatedAt = "2026-02-18T00:00:00.000Z",
    pullRequest = null,
  }: {
    title: string;
    body?: string;
    labels?: string[];
    author?: string;
    updatedAt?: string;
    pullRequest?: NormalizedItem["pullRequest"];
  }
): NormalizedItem {
  const itemPath = type === "pr" ? "pull" : "issues";

  return {
    id: number,
    number,
    type,
    title,
    body,
    links: {
      html: `https://github.com/thedotmack/claude-mem/${itemPath}/${number}`,
      api: `https://api.github.com/repos/thedotmack/claude-mem/issues/${number}`,
    },
    htmlUrl: `https://github.com/thedotmack/claude-mem/${itemPath}/${number}`,
    author: { login: author },
    labels: labels.map((name) => ({ name })),
    assignees: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    pullRequest,
  };
}

describe("issue-pr-bot scoring heuristics", () => {
  it("classifies intent using labels and title/body heuristics", () => {
    const items: NormalizedItem[] = [
      buildItem(11, "issue", {
        title: "Crash on startup after latest update",
        labels: ["bug"],
      }),
      buildItem(12, "issue", {
        title: "Add support for repository aliases",
        labels: ["enhancement"],
      }),
      buildItem(13, "issue", {
        title: "Docs: update README setup section",
      }),
      buildItem(14, "issue", {
        title: "Refactor queue processing path",
        labels: ["cleanup"],
      }),
      buildItem(15, "issue", {
        title: "Add integration tests for ingestion fallback",
        labels: ["test"],
      }),
      buildItem(16, "issue", {
        title: "Stabilize CI workflow for macOS builds",
        labels: ["ci"],
      }),
      buildItem(17, "issue", {
        title: "Bump dependencies for SDK updates",
        labels: ["dependencies"],
      }),
    ];

    const scoring = scoreAndRankItems(items, {
      now: NOW,
      outdatedThresholdDays: DEFAULT_OUTDATED_THRESHOLD_DAYS,
      developerPriorityOrder: [...DEFAULT_DEVELOPER_PRIORITY_ORDER],
    });
    const byNumber = new Map(scoring.issues.map((item) => [item.number, item]));

    expect(byNumber.get(11)?.intent).toBe("bug");
    expect(byNumber.get(12)?.intent).toBe("feature");
    expect(byNumber.get(13)?.intent).toBe("docs");
    expect(byNumber.get(14)?.intent).toBe("refactor");
    expect(byNumber.get(15)?.intent).toBe("test");
    expect(byNumber.get(16)?.intent).toBe("infra");
    expect(byNumber.get(17)?.intent).toBe("maintenance");
  });

  it("keeps globally critical items above developer-prioritized high items", () => {
    const items: NormalizedItem[] = [
      buildItem(21, "issue", {
        title: "Critical security vulnerability causing data loss",
        labels: ["security"],
        author: "external-contributor",
      }),
      buildItem(22, "issue", {
        title: "Improve non-blocking worker startup logging",
        labels: ["enhancement", "priority:high"],
        author: "thedotmack",
      }),
    ];

    const scoring = scoreAndRankItems(items, {
      now: NOW,
      outdatedThresholdDays: DEFAULT_OUTDATED_THRESHOLD_DAYS,
      developerPriorityOrder: [...DEFAULT_DEVELOPER_PRIORITY_ORDER],
    });

    expect(scoring.issues[0].number).toBe(21);
    expect(scoring.issues[0].severityBucket).toBe("critical");
    expect(scoring.issues[1].developerPriorityBoost).toBeGreaterThan(0);
  });

  it("marks outdated-close candidates using inactivity plus superseded/resolved signals", () => {
    const items: NormalizedItem[] = [
      buildItem(31, "issue", {
        title: "Legacy crash report no longer relevant",
        body: "Superseded by #1201 and fixed by #1202.",
        labels: ["bug"],
        updatedAt: "2025-09-01T00:00:00.000Z",
      }),
      buildItem(32, "issue", {
        title: "Old but still active idea",
        body: "No replacement linked.",
        labels: ["enhancement"],
        updatedAt: "2025-09-01T00:00:00.000Z",
      }),
      buildItem(33, "issue", {
        title: "Recently resolved via follow-up",
        body: "Fixed by #2001.",
        labels: ["bug"],
        updatedAt: "2026-02-10T00:00:00.000Z",
      }),
    ];

    const scoring = scoreAndRankItems(items, {
      now: NOW,
      outdatedThresholdDays: DEFAULT_OUTDATED_THRESHOLD_DAYS,
      developerPriorityOrder: [...DEFAULT_DEVELOPER_PRIORITY_ORDER],
    });
    const byNumber = new Map(scoring.issues.map((item) => [item.number, item]));

    expect(byNumber.get(31)?.outdatedCandidate).toBe(true);
    expect(byNumber.get(31)?.outdatedReasons).toContain("inactive-90-plus-days");
    expect(byNumber.get(31)?.outdatedReasons).toContain("superseded-reference");

    expect(byNumber.get(32)?.outdatedCandidate).toBe(false);
    expect(byNumber.get(33)?.outdatedCandidate).toBe(false);
  });
});
