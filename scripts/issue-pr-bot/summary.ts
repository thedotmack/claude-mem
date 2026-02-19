import type { TriageReport, TriageReportItem } from "./types.ts";

export interface TerminalSummaryPriorityItem {
  number: number;
  type: "issue" | "pr";
  title: string;
  score: number;
  severityBucket: TriageReportItem["severityBucket"];
  priorityBucket: TriageReportItem["priorityBucket"];
  outdatedCandidate: boolean;
}

export interface TerminalSummary {
  repository: string;
  runWikiLink: string;
  generatedAt: string;
  totalIssues: number;
  totalPullRequests: number;
  outdatedIssueCandidates: number;
  outdatedPullRequestCandidates: number;
  duplicateHints: number;
  relatedHints: number;
  topPriorities: TerminalSummaryPriorityItem[];
}

export interface BuildTerminalSummaryOptions {
  maxTopItems?: number;
}

const DUPLICATE_REASONS = new Set(["superseded-reference"]);

function comparePriorities(
  left: TriageReportItem,
  right: TriageReportItem
): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  if (left.type !== right.type) {
    return left.type === "issue" ? -1 : 1;
  }

  const rankDelta = left.rank - right.rank;
  if (rankDelta !== 0) {
    return rankDelta;
  }

  return left.number - right.number;
}

function toPriorityItem(item: TriageReportItem): TerminalSummaryPriorityItem {
  return {
    number: item.number,
    type: item.type,
    title: item.title,
    score: item.score,
    severityBucket: item.severityBucket,
    priorityBucket: item.priorityBucket,
    outdatedCandidate: item.outdatedCandidate,
  };
}

export function buildTerminalSummary(
  report: TriageReport,
  options: BuildTerminalSummaryOptions = {}
): TerminalSummary {
  const maxTopItems = Math.max(1, Math.floor(options.maxTopItems ?? 5));
  const allItems = [...report.items.issues, ...report.items.prs];
  const activeItems = allItems.filter((item) => !item.outdatedCandidate);
  const topSourceItems = activeItems.length > 0 ? activeItems : allItems;
  const topPriorities = [...topSourceItems]
    .sort(comparePriorities)
    .slice(0, maxTopItems)
    .map(toPriorityItem);

  const duplicateHints = allItems.filter((item) =>
    item.outdatedReasons.some((reason) => DUPLICATE_REASONS.has(reason))
  ).length;
  const relatedHints = allItems.reduce(
    (total, item) => total + item.relatedWikiLinks.length,
    0
  );

  return {
    repository: `${report.snapshot.repository.owner}/${report.snapshot.repository.repo}`,
    runWikiLink: report.runWikiLink,
    generatedAt: report.snapshot.generatedAt,
    totalIssues: report.snapshot.summary.totalIssues,
    totalPullRequests: report.snapshot.summary.totalPullRequests,
    outdatedIssueCandidates: report.snapshot.summary.outdatedIssueCandidates,
    outdatedPullRequestCandidates: report.snapshot.summary.outdatedPullRequestCandidates,
    duplicateHints,
    relatedHints,
    topPriorities,
  };
}

export function renderTerminalSummary(summary: TerminalSummary): string {
  const lines: string[] = [
    "Issue/PR Prototype Triage Summary",
    `Repository: ${summary.repository}`,
    `Generated: ${summary.generatedAt}`,
    `Run Link: ${summary.runWikiLink}`,
    "",
    `Open issues: ${summary.totalIssues}`,
    `Open pull requests: ${summary.totalPullRequests}`,
    `Outdated-close candidates: issues ${summary.outdatedIssueCandidates}, PRs ${summary.outdatedPullRequestCandidates}`,
    `Duplicate/related hints found: ${summary.duplicateHints} duplicate, ${summary.relatedHints} related`,
    "",
    "Top priorities:",
  ];

  if (summary.topPriorities.length === 0) {
    lines.push("1. No triage items found.");
    return lines.join("\n");
  }

  summary.topPriorities.forEach((item, index) => {
    lines.push(
      `${index + 1}. ${item.type.toUpperCase()} #${item.number} (${item.severityBucket}/${item.priorityBucket}) score=${item.score} ${item.title}`
    );
  });

  return lines.join("\n");
}
