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
  MISSING_AUTH_WARNING,
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

  it("supports dependency override for ingestion", async () => {
    const config = createTriageConfig({ generatedAt: "2026-02-19T00:00:00.000Z" });
    const result = await ingestOpenItems(config, {
      fetchOpenItems: async () => [],
    });

    expect(result.items).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns when running without GitHub auth token", async () => {
    const config = createTriageConfig({
      repository: { owner: "test", repo: "repo" },
      generatedAt: "2026-02-19T00:00:00.000Z",
    });

    const result = await ingestOpenItems(config, {
      githubToken: null,
      apiFetch: async () => {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(result.warnings).toContain(MISSING_AUTH_WARNING);
  });

  it("ranks issues and pull requests in deterministic order", () => {
    const items: NormalizedItem[] = [
      {
        id: 1,
        number: 10,
        type: "issue",
        title: "Older issue",
        body: "",
        links: {
          html: "https://example.com/issues/10",
          api: "https://api.github.com/repos/example/repo/issues/10",
        },
        htmlUrl: "https://example.com/issues/10",
        author: { login: "alice" },
        labels: [],
        assignees: [],
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-11T00:00:00.000Z",
        pullRequest: null,
      },
      {
        id: 2,
        number: 12,
        type: "issue",
        title: "Newer issue",
        body: "",
        links: {
          html: "https://example.com/issues/12",
          api: "https://api.github.com/repos/example/repo/issues/12",
        },
        htmlUrl: "https://example.com/issues/12",
        author: { login: "bob" },
        labels: [],
        assignees: [],
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-12T00:00:00.000Z",
        pullRequest: null,
      },
      {
        id: 3,
        number: 21,
        type: "pr",
        title: "Only PR",
        body: "",
        links: {
          html: "https://example.com/pull/21",
          api: "https://api.github.com/repos/example/repo/issues/21",
        },
        htmlUrl: "https://example.com/pull/21",
        author: { login: "charlie" },
        labels: [],
        assignees: [],
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-12T00:00:00.000Z",
        pullRequest: {
          changedFiles: 4,
          additions: 40,
          deletions: 12,
          commits: 2,
        },
      },
    ];

    const scoring = scoreAndRankItems(items, {
      now: "2026-02-19T00:00:00.000Z",
      outdatedThresholdDays: 90,
      developerPriorityOrder: [...DEFAULT_DEVELOPER_PRIORITY_ORDER],
    });

    expect(scoring.issues[0].score).toBeGreaterThan(scoring.issues[1].score);
    expect(scoring.issues.map((item) => item.number)).toEqual([12, 10]);
    expect(scoring.issues.map((item) => item.rank)).toEqual([1, 2]);
    expect(scoring.issues[0].intent).toBe("bug");
    expect(scoring.issues[0].outdatedCandidate).toBe(false);
    expect(scoring.prs.map((item) => item.number)).toEqual([21]);
    expect(scoring.prs.map((item) => item.rank)).toEqual([1]);
    expect(scoring.prs[0].intent).toBe("maintenance");
  });

  it("renders separate issue and pull request sections", () => {
    const config = createTriageConfig({ generatedAt: "2026-02-19T00:00:00.000Z" });
    const scoring = scoreAndRankItems([]);
    const report = renderTriageReport(config, scoring);

    expect(report.markdown).toContain("## Issues");
    expect(report.markdown).toContain("## Pull Requests");
  });
});
