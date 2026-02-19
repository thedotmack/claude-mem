import { describe, expect, it } from "bun:test";

import { createTriageConfig } from "../../../scripts/issue-pr-bot/config.ts";
import { renderTriageReport } from "../../../scripts/issue-pr-bot/reporting.ts";
import { scoreAndRankItems } from "../../../scripts/issue-pr-bot/scoring.ts";
import {
  buildTerminalSummary,
  renderTerminalSummary,
} from "../../../scripts/issue-pr-bot/summary.ts";
import type { NormalizedItem, TriageItemType } from "../../../scripts/issue-pr-bot/types.ts";

const NOW = "2026-02-19T12:00:00.000Z";

function buildItem(
  number: number,
  type: TriageItemType,
  {
    title,
    body = "",
    labels = [],
    updatedAt = "2026-02-18T00:00:00.000Z",
    pullRequest = null,
  }: {
    title: string;
    body?: string;
    labels?: string[];
    updatedAt?: string;
    pullRequest?: NormalizedItem["pullRequest"];
  }
): NormalizedItem {
  const segment = type === "issue" ? "issues" : "pull";

  return {
    id: number,
    number,
    type,
    title,
    body,
    links: {
      html: `https://github.com/thedotmack/claude-mem/${segment}/${number}`,
      api: `https://api.github.com/repos/thedotmack/claude-mem/issues/${number}`,
    },
    htmlUrl: `https://github.com/thedotmack/claude-mem/${segment}/${number}`,
    author: { login: "contributor" },
    labels: labels.map((name) => ({ name })),
    assignees: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    pullRequest,
  };
}

describe("issue-pr-bot terminal summary", () => {
  it("builds compact summary counts and top priorities", () => {
    const config = createTriageConfig({ generatedAt: NOW });
    const items: NormalizedItem[] = [
      buildItem(11, "issue", {
        title: "Security crash in startup flow",
        body: "Related follow-up in #21.",
        labels: ["security", "bug"],
      }),
      buildItem(12, "issue", {
        title: "Legacy bug no longer active",
        body: "Superseded by #21 and fixed by #21.",
        labels: ["bug"],
        updatedAt: "2025-09-01T00:00:00.000Z",
      }),
      buildItem(21, "pr", {
        title: "Refactor worker restart flow",
        labels: ["maintenance"],
        pullRequest: {
          changedFiles: 8,
          additions: 110,
          deletions: 55,
          commits: 3,
        },
      }),
    ];

    const scoring = scoreAndRankItems(items, {
      now: NOW,
      outdatedThresholdDays: 90,
      developerPriorityOrder: config.developerPriorityOrder,
    });
    const report = renderTriageReport(config, scoring);
    const summary = buildTerminalSummary(report, { maxTopItems: 2 });

    expect(summary.totalIssues).toBe(2);
    expect(summary.totalPullRequests).toBe(1);
    expect(summary.outdatedIssueCandidates).toBe(1);
    expect(summary.outdatedPullRequestCandidates).toBe(0);
    expect(summary.duplicateHints).toBe(1);
    expect(summary.relatedHints).toBe(2);
    expect(summary.topPriorities).toHaveLength(2);
    expect(summary.topPriorities.every((item) => !item.outdatedCandidate)).toBe(true);
    expect(summary.topPriorities.map((item) => item.number)).toEqual([11, 21]);
  });

  it("renders terminal summary text with required metrics", () => {
    const rendered = renderTerminalSummary({
      repository: "thedotmack/claude-mem",
      runWikiLink: "[[Triage-Run-2026-02-19]]",
      generatedAt: NOW,
      totalIssues: 7,
      totalPullRequests: 5,
      outdatedIssueCandidates: 2,
      outdatedPullRequestCandidates: 1,
      duplicateHints: 3,
      relatedHints: 8,
      topPriorities: [
        {
          number: 123,
          type: "issue",
          title: "Critical startup crash",
          score: 5120,
          severityBucket: "critical",
          priorityBucket: "urgent",
          outdatedCandidate: false,
        },
      ],
    });

    expect(rendered).toContain("Open issues: 7");
    expect(rendered).toContain("Open pull requests: 5");
    expect(rendered).toContain("Outdated-close candidates: issues 2, PRs 1");
    expect(rendered).toContain("Duplicate/related hints found: 3 duplicate, 8 related");
    expect(rendered).toContain("1. ISSUE #123 (critical/urgent) score=5120");
  });
});
