import type { RankedItem, ScoringResult, TriageConfig, TriageReport } from "./types.ts";

function renderSection(title: string, items: RankedItem[]): string {
  const lines: string[] = [`## ${title}`, ""];

  if (items.length === 0) {
    lines.push("- No items yet.");
    return lines.join("\n");
  }

  for (const item of items) {
    lines.push(
      `- #${item.number} [${item.title}](${item.htmlUrl}) (rank ${item.rank}, score ${item.score})`
    );
  }

  return lines.join("\n");
}

export function renderTriageReport(
  config: TriageConfig,
  scoring: ScoringResult
): TriageReport {
  const header = [
    "# Issue/PR Prototype Triage Report",
    "",
    `Repository: ${config.repository.owner}/${config.repository.repo}`,
    `Generated: ${config.generatedAt}`,
    "",
  ].join("\n");

  const issues = renderSection("Issues", scoring.issues);
  const prs = renderSection("Pull Requests", scoring.prs);

  return {
    markdown: [header, issues, "", prs].join("\n"),
    sections: {
      issues,
      prs,
    },
  };
}
