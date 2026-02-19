import { describe, expect, it } from "bun:test";

import {
  createTriageConfig,
  DEFAULT_DEVELOPER_PRIORITY_ORDER,
  DEFAULT_DISCOVERY_SCOPE,
  DEFAULT_OUTDATED_THRESHOLD_DAYS,
  DEFAULT_OUTPUT_SECTIONS,
} from "../../../scripts/issue-pr-bot/config.ts";
import {
  ingestOpenItems,
  SCAFFOLD_WARNING,
} from "../../../scripts/issue-pr-bot/ingestion.ts";
import { renderTriageReport } from "../../../scripts/issue-pr-bot/reporting.ts";
import {
  PRIORITY_BUCKET_ORDER,
  PRIORITY_BUCKET_WEIGHTS,
  scoreAndRankItems,
  SEVERITY_BUCKET_ORDER,
  SEVERITY_BUCKET_WEIGHTS,
} from "../../../scripts/issue-pr-bot/scoring.ts";
import type { NormalizedItem } from "../../../scripts/issue-pr-bot/types.ts";

describe("issue-pr-bot scaffold", () => {
  it("builds default config with expected repository", () => {
    const config = createTriageConfig({ generatedAt: "2026-02-19T00:00:00.000Z" });

    expect(config.repository.owner).toBe("thedotmack");
    expect(config.repository.repo).toBe("claude-mem");
    expect(config.discovery.scope).toBe(DEFAULT_DISCOVERY_SCOPE);
    expect(config.discovery.outdatedThresholdDays).toBe(
      DEFAULT_OUTDATED_THRESHOLD_DAYS
    );
    expect(config.output.sections).toEqual(DEFAULT_OUTPUT_SECTIONS);
    expect(config.developerPriorityOrder).toEqual(
      DEFAULT_DEVELOPER_PRIORITY_ORDER
    );
    expect(config.generatedAt).toBe("2026-02-19T00:00:00.000Z");
  });

  it("defines deterministic severity and priority buckets", () => {
    expect(SEVERITY_BUCKET_ORDER).toEqual(["critical", "high", "medium", "low"]);
    expect(PRIORITY_BUCKET_ORDER).toEqual(["urgent", "high", "normal", "low"]);
    expect(SEVERITY_BUCKET_WEIGHTS.medium).toBe(2_000);
    expect(PRIORITY_BUCKET_WEIGHTS.normal).toBe(200);
  });

  it("returns scaffold warning when ingestion has no dependency", async () => {
    const config = createTriageConfig({ generatedAt: "2026-02-19T00:00:00.000Z" });
    const result = await ingestOpenItems(config);

    expect(result.items).toHaveLength(0);
    expect(result.warnings).toEqual([SCAFFOLD_WARNING]);
  });

  it("ranks issues and pull requests in deterministic order", () => {
    const items: NormalizedItem[] = [
      {
        id: 1,
        number: 10,
        type: "issue",
        title: "Older issue",
        body: "",
        htmlUrl: "https://example.com/issues/10",
        author: { login: "alice" },
        labels: [],
        assignees: [],
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-11T00:00:00.000Z",
      },
      {
        id: 2,
        number: 12,
        type: "issue",
        title: "Newer issue",
        body: "",
        htmlUrl: "https://example.com/issues/12",
        author: { login: "bob" },
        labels: [],
        assignees: [],
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-12T00:00:00.000Z",
      },
      {
        id: 3,
        number: 21,
        type: "pr",
        title: "Only PR",
        body: "",
        htmlUrl: "https://example.com/pull/21",
        author: { login: "charlie" },
        labels: [],
        assignees: [],
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-12T00:00:00.000Z",
      },
    ];

    const scoring = scoreAndRankItems(items);

    expect(scoring.issues[0].score).toBe(2_200);
    expect(scoring.issues.map((item) => item.number)).toEqual([12, 10]);
    expect(scoring.issues.map((item) => item.rank)).toEqual([1, 2]);
    expect(scoring.prs.map((item) => item.number)).toEqual([21]);
    expect(scoring.prs.map((item) => item.rank)).toEqual([1]);
  });

  it("renders separate issue and pull request sections", () => {
    const config = createTriageConfig({ generatedAt: "2026-02-19T00:00:00.000Z" });
    const scoring = scoreAndRankItems([]);
    const report = renderTriageReport(config, scoring);

    expect(report.markdown).toContain("## Issues");
    expect(report.markdown).toContain("## Pull Requests");
  });
});
