import { describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  createTriageConfig,
  DEFAULT_DEVELOPER_PRIORITY_ORDER,
} from "../../../scripts/issue-pr-bot/config.ts";
import {
  renderTriageReport,
  writeTriageArtifacts,
} from "../../../scripts/issue-pr-bot/reporting.ts";
import { scoreAndRankItems } from "../../../scripts/issue-pr-bot/scoring.ts";
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

describe("issue-pr-bot reporting artifacts", () => {
  it("renders wiki-linked triage sections with draft plans", () => {
    const config = createTriageConfig({ generatedAt: NOW });
    const items: NormalizedItem[] = [
      buildItem(11, "issue", {
        title: "Crash when opening settings",
        body: "Repro attached.",
        labels: ["bug", "priority:high"],
      }),
      buildItem(12, "issue", {
        title: "Old issue resolved in newer work",
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
      developerPriorityOrder: [...DEFAULT_DEVELOPER_PRIORITY_ORDER],
    });
    const report = renderTriageReport(config, scoring);

    const issue11 = report.items.issues.find((item) => item.number === 11);
    const issue12 = report.items.issues.find((item) => item.number === 12);

    expect(report.runId).toBe("Triage-Run-2026-02-19");
    expect(report.runWikiLink).toBe("[[Triage-Run-2026-02-19]]");
    expect(report.markdown).toContain("[[Issue-11]]");
    expect(report.markdown).toContain("[[PR-21]]");
    expect(report.sections.issues).toContain("outdated-close-candidate: yes");

    expect(issue11?.draftPlan).toBeTruthy();
    expect(issue12?.outdatedCandidate).toBe(true);
    expect(issue12?.draftPlan).toBeNull();
    expect(issue12?.relatedWikiLinks).toContain("[[PR-21]]");
  });

  it("writes structured markdown artifacts and machine snapshot files", async () => {
    const config = createTriageConfig({ generatedAt: NOW });
    const items: NormalizedItem[] = [
      buildItem(11, "issue", {
        title: "Crash when opening settings",
        body: "Repro attached.",
        labels: ["bug", "priority:high"],
      }),
      buildItem(12, "issue", {
        title: "Old issue resolved in newer work",
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
      developerPriorityOrder: [...DEFAULT_DEVELOPER_PRIORITY_ORDER],
    });
    const report = renderTriageReport(config, scoring);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-pr-bot-reporting-"));

    try {
      const outputRootDir = path.join(tempDir, "docs", "triage");
      const artifacts = await writeTriageArtifacts(config, report, {
        outputRootDir,
      });

      expect(artifacts.rootDir).toBe(outputRootDir);
      expect(await fs.stat(path.join(outputRootDir, "issues"))).toBeTruthy();
      expect(await fs.stat(path.join(outputRootDir, "prs"))).toBeTruthy();

      const runReportContent = await fs.readFile(artifacts.runReportPath, "utf-8");
      expect(runReportContent.startsWith("---\n")).toBe(true);
      expect(runReportContent).toContain("type: report");
      expect(runReportContent).toContain("title:");
      expect(runReportContent).toContain("created: 2026-02-19");
      expect(runReportContent).toContain("tags:");
      expect(runReportContent).toContain("related:");
      expect(runReportContent).toContain("[[Issue-11]]");
      expect(runReportContent).toContain("[[PR-21]]");

      const issue11Path = artifacts.issueItemPaths.find((filePath) =>
        filePath.endsWith("Issue-11.md")
      );
      const issue12Path = artifacts.issueItemPaths.find((filePath) =>
        filePath.endsWith("Issue-12.md")
      );
      const pr21Path = artifacts.prItemPaths.find((filePath) =>
        filePath.endsWith("PR-21.md")
      );

      expect(issue11Path).toBeDefined();
      expect(issue12Path).toBeDefined();
      expect(pr21Path).toBeDefined();

      const issue11Content = await fs.readFile(issue11Path!, "utf-8");
      expect(issue11Content).toContain("type: analysis");
      expect(issue11Content).toContain("created: 2026-02-19");
      expect(issue11Content).toContain("[[Triage-Run-2026-02-19]]");
      expect(issue11Content).toContain("## Draft Execution Plan");
      expect(issue11Content).toContain("### Next Steps");
      expect(issue11Content).toContain("### Risks");
      expect(issue11Content).toContain("### Validation Checks");

      const issue12Content = await fs.readFile(issue12Path!, "utf-8");
      expect(issue12Content).toContain("## Outdated Candidate Review");
      expect(issue12Content).not.toContain("## Draft Execution Plan");
      expect(issue12Content).toContain("[[PR-21]]");

      const snapshotRaw = await fs.readFile(artifacts.snapshotPath, "utf-8");
      const snapshot = JSON.parse(snapshotRaw) as {
        runId: string;
        summary: {
          totalIssues: number;
          totalPullRequests: number;
          outdatedIssueCandidates: number;
        };
        sections: {
          issues: Array<{ number: number; draftPlan: unknown }>;
        };
      };

      expect(snapshot.runId).toBe("Triage-Run-2026-02-19");
      expect(snapshot.summary.totalIssues).toBe(2);
      expect(snapshot.summary.totalPullRequests).toBe(1);
      expect(snapshot.summary.outdatedIssueCandidates).toBe(1);

      const snapshotIssue11 = snapshot.sections.issues.find((item) => item.number === 11);
      const snapshotIssue12 = snapshot.sections.issues.find((item) => item.number === 12);
      expect(snapshotIssue11?.draftPlan).toBeTruthy();
      expect(snapshotIssue12?.draftPlan).toBeNull();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
