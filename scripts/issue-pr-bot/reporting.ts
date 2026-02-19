import * as fs from "fs/promises";
import * as path from "path";
import type {
  CategorizedItem,
  CategoryCluster,
  DraftExecutionPlan,
  DuplicateGroup,
  RankedItem,
  ScoringResult,
  TriageArtifactPaths,
  TriageConfig,
  TriageItemType,
  TriageReport,
  TriageReportItem,
  TriageSnapshot,
} from "./types.ts";

const DEFAULT_TRIAGE_OUTPUT_ROOT = path.join("docs", "triage");

interface FrontMatterPayload {
  type: "report" | "analysis";
  title: string;
  created: string;
  tags: string[];
  related: string[];
}

interface WriteTriageArtifactsOptions {
  outputRootDir?: string;
}

function toCreatedDate(isoTimestamp: string): string {
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) {
    return new Date().toISOString().slice(0, 10);
  }

  return new Date(parsed).toISOString().slice(0, 10);
}

function toRunId(createdDate: string): string {
  return `Triage-Run-${createdDate}`;
}

function toItemSlug(type: TriageItemType, number: number): string {
  return `${type === "issue" ? "Issue" : "PR"}-${number}`;
}

function toItemWikiLink(type: TriageItemType, number: number): string {
  return `[[${toItemSlug(type, number)}]]`;
}

function buildFrontMatter(payload: FrontMatterPayload): string {
  const lines: string[] = [
    "---",
    `type: ${payload.type}`,
    `title: ${JSON.stringify(payload.title)}`,
    `created: ${payload.created}`,
    "tags:",
  ];

  if (payload.tags.length === 0) {
    lines.push("  - triage");
  } else {
    for (const tag of payload.tags) {
      lines.push(`  - ${tag}`);
    }
  }

  lines.push("related:");
  if (payload.related.length === 0) {
    lines.push('  - "[[Triage]]"');
  } else {
    for (const relatedEntry of payload.related) {
      lines.push(`  - ${JSON.stringify(relatedEntry)}`);
    }
  }

  lines.push("---", "");
  return lines.join("\n");
}

function buildDraftExecutionPlan(item: RankedItem): DraftExecutionPlan | null {
  if (item.outdatedCandidate) {
    return null;
  }

  const nextSteps: string[] = [];
  const risks: string[] = [];
  const validationChecks: string[] = [];

  if (item.type === "issue") {
    nextSteps.push(
      "Review the latest issue timeline and confirm the current problem statement."
    );
    if (item.intent === "bug") {
      nextSteps.push("Reproduce the failure and isolate the smallest safe fix.");
    } else if (item.intent === "feature") {
      nextSteps.push("Define acceptance criteria and scope a minimal implementation.");
    } else if (item.intent === "docs") {
      nextSteps.push("Update docs sections and align examples with current behavior.");
    } else if (item.intent === "infra") {
      nextSteps.push("Identify workflow/config touchpoints and prepare a safe rollout.");
    } else if (item.intent === "test") {
      nextSteps.push("Add or update failing tests before touching implementation logic.");
    } else if (item.intent === "refactor") {
      nextSteps.push("Limit refactor boundaries and preserve behavior with checkpoints.");
    } else {
      nextSteps.push("Prepare a scoped implementation update with rollback awareness.");
    }
  } else {
    nextSteps.push("Review PR diff, unresolved comments, and merge-readiness blockers.");
    const changedFiles = item.pullRequest?.changedFiles ?? 0;
    if (changedFiles >= 40) {
      nextSteps.push("Review high-risk files first, then complete low-risk cleanup.");
    } else {
      nextSteps.push("Validate branch scope against the stated intent before merge.");
    }
  }

  if (item.severityBucket === "critical") {
    risks.push("Critical severity may need immediate coordination and rollback options.");
  } else if (item.severityBucket === "high") {
    risks.push("High-severity changes can regress user-critical flows if scope drifts.");
  } else {
    risks.push("Hidden edge cases may remain if the issue context is incomplete.");
  }

  if (item.inactivityDays >= 30) {
    risks.push("Project context may have shifted due to prolonged inactivity.");
  } else {
    risks.push("Ongoing discussion churn can change acceptance criteria mid-implementation.");
  }

  validationChecks.push("Run targeted tests for affected areas and verify no new failures.");
  if (item.intent === "docs") {
    validationChecks.push("Validate docs commands/paths against the current repository.");
  } else if (item.intent === "infra") {
    validationChecks.push("Dry-run automation/workflow changes before rollout.");
  } else if (item.type === "pr") {
    validationChecks.push("Confirm CI state, review status, and merge conflict readiness.");
  } else {
    validationChecks.push("Re-check the original report scenario end-to-end.");
  }

  return {
    nextSteps,
    risks,
    validationChecks,
  };
}

function extractRelatedWikiLinks(
  item: RankedItem,
  itemTypeByNumber: Map<number, TriageItemType>
): string[] {
  const references = new Set<string>();
  const sourceText = `${item.title}\n${item.body}`;
  const referencePattern = /#(\d+)/g;

  for (const match of sourceText.matchAll(referencePattern)) {
    const number = Number.parseInt(match[1], 10);
    if (!Number.isFinite(number) || number === item.number) {
      continue;
    }

    const relatedType = itemTypeByNumber.get(number);
    if (!relatedType) {
      continue;
    }

    references.add(toItemWikiLink(relatedType, number));
  }

  return [...references];
}

function toReportItems(
  items: RankedItem[],
  itemTypeByNumber: Map<number, TriageItemType>
): TriageReportItem[] {
  return items.map((item) => ({
    number: item.number,
    type: item.type,
    title: item.title,
    htmlUrl: item.htmlUrl,
    rank: item.rank,
    score: item.score,
    intent: item.intent,
    severityBucket: item.severityBucket,
    priorityBucket: item.priorityBucket,
    inactivityDays: item.inactivityDays,
    outdatedCandidate: item.outdatedCandidate,
    outdatedReasons: [...item.outdatedReasons],
    wikiLink: toItemWikiLink(item.type, item.number),
    relatedWikiLinks: extractRelatedWikiLinks(item, itemTypeByNumber),
    draftPlan: buildDraftExecutionPlan(item),
    authorLogin: item.author?.login ?? null,
    mergeableState: item.mergeableState,
    reviewDecision: item.reviewDecision,
  }));
}

function renderSection(title: string, items: TriageReportItem[]): string {
  const lines: string[] = [`## ${title}`, ""];

  if (items.length === 0) {
    lines.push("- No items yet.");
    return lines.join("\n");
  }

  for (const item of items) {
    lines.push(
      `- ${item.wikiLink} [#${item.number} ${item.title}](${item.htmlUrl}) | rank ${item.rank} | score ${item.score}`
    );
    lines.push(
      `  - classification: intent=${item.intent}, severity=${item.severityBucket}, priority=${item.priorityBucket}`
    );
    lines.push(`  - inactivity: ${item.inactivityDays} days`);

    if (item.type === "pr") {
      const prDetails: string[] = [];
      if (item.mergeableState) {
        prDetails.push(`mergeable: ${item.mergeableState}`);
      }
      if (item.reviewDecision) {
        prDetails.push(`review: ${item.reviewDecision}`);
      }
      if (prDetails.length > 0) {
        lines.push(`  - pr-details: ${prDetails.join(", ")}`);
      }
    }

    if (item.relatedWikiLinks.length > 0) {
      lines.push(`  - related: ${item.relatedWikiLinks.join(", ")}`);
    }

    if (item.outdatedCandidate) {
      const reasons =
        item.outdatedReasons.length > 0 ? item.outdatedReasons.join(", ") : "n/a";
      lines.push(`  - outdated-close-candidate: yes (${reasons})`);
      continue;
    }

    if (item.draftPlan) {
      lines.push(`  - plan next: ${item.draftPlan.nextSteps.join(" ")}`);
      lines.push(`  - plan risks: ${item.draftPlan.risks.join(" ")}`);
      lines.push(`  - plan validation: ${item.draftPlan.validationChecks.join(" ")}`);
    }
  }

  return lines.join("\n");
}

function renderDeveloperBreakdown(
  allItems: TriageReportItem[],
  developerPriorityOrder: string[]
): string {
  const lines: string[] = ["## Developer Breakdown", ""];

  let hasContent = false;
  for (const developer of developerPriorityOrder) {
    const authoredItems = allItems.filter(
      (item) => item.authorLogin === developer
    );

    if (authoredItems.length > 0) {
      hasContent = true;
      lines.push(`### ${developer} (${authoredItems.length} items)`, "");
      for (const item of authoredItems) {
        lines.push(
          `- #${item.number} [${item.title}](${item.htmlUrl}) — ${item.type}, severity: ${item.severityBucket}`
        );
      }
      lines.push("");
    }
  }

  if (!hasContent) {
    lines.push("No items from priority developers.");
  }

  return lines.join("\n");
}

export interface CategorizationEnrichment {
  categorized: CategorizedItem[];
  duplicateGroups: DuplicateGroup[];
}

const CATEGORY_DISPLAY_NAMES: Record<CategoryCluster, string> = {
  chroma: "Chroma",
  "process-lifecycle": "Process",
  windows: "Windows",
  hooks: "Hooks",
  installation: "Installation",
  security: "Security",
  "feature-request": "Feature Request",
  spam: "Spam",
  uncategorized: "Uncategorized",
};

function renderCategorySummary(categorized: CategorizedItem[]): string {
  const countsByCategory = new Map<CategoryCluster, number>();
  for (const item of categorized) {
    countsByCategory.set(item.category, (countsByCategory.get(item.category) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const [category, displayName] of Object.entries(CATEGORY_DISPLAY_NAMES)) {
    const count = countsByCategory.get(category as CategoryCluster) ?? 0;
    if (count > 0) {
      parts.push(`${displayName}: ${count}`);
    }
  }

  return parts.join(", ");
}

function renderIssuesByCategory(categorized: CategorizedItem[]): string {
  const lines: string[] = ["## Issues by Category", ""];

  const itemsByCategory = new Map<CategoryCluster, CategorizedItem[]>();
  for (const item of categorized) {
    const existing = itemsByCategory.get(item.category) ?? [];
    existing.push(item);
    itemsByCategory.set(item.category, existing);
  }

  for (const [category, displayName] of Object.entries(CATEGORY_DISPLAY_NAMES)) {
    const items = itemsByCategory.get(category as CategoryCluster);
    if (!items || items.length === 0) {
      continue;
    }

    lines.push(`### ${displayName} (${items.length})`, "");
    for (const item of items) {
      lines.push(`- #${item.number} ${item.title} (${item.htmlUrl})`);
    }
    lines.push("");
  }

  if (lines.length === 2) {
    lines.push("No categorized items.");
  }

  return lines.join("\n");
}

function renderDuplicateGroups(duplicateGroups: DuplicateGroup[]): string {
  const lines: string[] = ["## Duplicate Groups", ""];

  if (duplicateGroups.length === 0) {
    lines.push("No duplicate groups detected.");
    return lines.join("\n");
  }

  for (const group of duplicateGroups) {
    lines.push(`### Group ${group.groupId}`);
    lines.push(`- Canonical: #${group.canonical}`);
    lines.push(`- Duplicates: ${group.duplicates.map((num) => `#${num}`).join(", ")}`);
    lines.push(`- Reason: ${group.reason}`);
    lines.push("");
  }

  return lines.join("\n");
}

function renderRunBody(
  config: TriageConfig,
  runWikiLink: string,
  issues: TriageReportItem[],
  prs: TriageReportItem[],
  enrichment?: CategorizationEnrichment
): { markdown: string; issuesSection: string; prsSection: string } {
  const issueOutdatedCount = issues.filter((item) => item.outdatedCandidate).length;
  const prOutdatedCount = prs.filter((item) => item.outdatedCandidate).length;

  const headerLines = [
    "# Issue/PR Prototype Triage Report",
    "",
    `Repository: ${config.repository.owner}/${config.repository.repo}`,
    `Generated: ${config.generatedAt}`,
    `Run Link: ${runWikiLink}`,
    "",
    "## Summary",
    "",
    `- Open issues: ${issues.length}`,
    `- Open pull requests: ${prs.length}`,
    `- Outdated-close issue candidates: ${issueOutdatedCount}`,
    `- Outdated-close PR candidates: ${prOutdatedCount}`,
  ];

  if (enrichment) {
    const categorySummary = renderCategorySummary(enrichment.categorized);
    if (categorySummary.length > 0) {
      headerLines.push(`- Categories: ${categorySummary}`);
    }
    headerLines.push(`- Duplicate groups: ${enrichment.duplicateGroups.length}`);
  }

  const header = headerLines.join("\n");

  const issuesSection = renderSection("Issues", issues);
  const prsSection = renderSection("Pull Requests", prs);
  const developerBreakdown = renderDeveloperBreakdown(
    [...issues, ...prs],
    config.developerPriorityOrder
  );

  const configuredSections = config.output.sections
    .map((section) => (section === "issues" ? issuesSection : prsSection))
    .join("\n\n");

  const markdownParts = [header, configuredSections, developerBreakdown];

  if (enrichment) {
    markdownParts.push(renderIssuesByCategory(enrichment.categorized));
    markdownParts.push(renderDuplicateGroups(enrichment.duplicateGroups));
  }

  return {
    markdown: markdownParts.join("\n\n"),
    issuesSection,
    prsSection,
  };
}

function buildSnapshot(
  config: TriageConfig,
  runId: string,
  runWikiLink: string,
  issues: TriageReportItem[],
  prs: TriageReportItem[]
): TriageSnapshot {
  return {
    runId,
    runWikiLink,
    generatedAt: config.generatedAt,
    repository: { ...config.repository },
    summary: {
      totalIssues: issues.length,
      totalPullRequests: prs.length,
      outdatedIssueCandidates: issues.filter((item) => item.outdatedCandidate).length,
      outdatedPullRequestCandidates: prs.filter((item) => item.outdatedCandidate).length,
    },
    sections: {
      issues,
      prs,
    },
  };
}

function renderItemArtifactBody(
  item: TriageReportItem,
  runWikiLink: string
): string {
  const typeLabel = item.type === "issue" ? "Issue" : "PR";
  const lines: string[] = [
    `# ${typeLabel} #${item.number}: ${item.title}`,
    "",
    `- Link: [GitHub](${item.htmlUrl})`,
    `- Run: ${runWikiLink}`,
    "",
    "## Triage Summary",
    "",
    `- Rank: ${item.rank}`,
    `- Score: ${item.score}`,
    `- Intent: ${item.intent}`,
    `- Severity: ${item.severityBucket}`,
    `- Priority: ${item.priorityBucket}`,
    `- Inactivity Days: ${item.inactivityDays}`,
  ];

  if (item.relatedWikiLinks.length > 0) {
    lines.push(`- Related Items: ${item.relatedWikiLinks.join(", ")}`);
  }

  if (item.outdatedCandidate) {
    const reasons =
      item.outdatedReasons.length > 0 ? item.outdatedReasons : ["no explicit reasons"];
    lines.push(
      "",
      "## Outdated Candidate Review",
      "",
      "- Status: candidate for close",
      `- Reasons: ${reasons.join(", ")}`
    );
    return lines.join("\n");
  }

  const draftPlan = item.draftPlan;
  if (!draftPlan) {
    return lines.join("\n");
  }

  lines.push("", "## Draft Execution Plan", "", "### Next Steps", "");
  for (const step of draftPlan.nextSteps) {
    lines.push(`- ${step}`);
  }

  lines.push("", "### Risks", "");
  for (const risk of draftPlan.risks) {
    lines.push(`- ${risk}`);
  }

  lines.push("", "### Validation Checks", "");
  for (const check of draftPlan.validationChecks) {
    lines.push(`- ${check}`);
  }

  return lines.join("\n");
}

async function writeItemArtifacts(
  items: TriageReportItem[],
  directory: string,
  createdDate: string,
  runWikiLink: string
): Promise<string[]> {
  const itemPaths: string[] = [];

  for (const item of items) {
    const typeLabel = item.type === "issue" ? "Issue" : "PR";
    const itemSlug = toItemSlug(item.type, item.number);
    const itemWikiLink = `[[${itemSlug}]]`;
    const relatedLinks = Array.from(
      new Set([runWikiLink, itemWikiLink, ...item.relatedWikiLinks])
    );
    const tags = [
      "triage",
      item.type,
      `intent-${item.intent}`,
      `severity-${item.severityBucket}`,
      `priority-${item.priorityBucket}`,
    ];
    if (item.outdatedCandidate) {
      tags.push("outdated-candidate");
    }

    const frontMatter = buildFrontMatter({
      type: "analysis",
      title: `${typeLabel} #${item.number}: ${item.title}`,
      created: createdDate,
      tags,
      related: relatedLinks,
    });
    const body = renderItemArtifactBody(item, runWikiLink);
    const fullContent = `${frontMatter}${body}\n`;
    const filePath = path.join(directory, `${itemSlug}.md`);

    await fs.writeFile(filePath, fullContent, "utf-8");
    itemPaths.push(filePath);
  }

  return itemPaths;
}

export function renderTriageReport(
  config: TriageConfig,
  scoring: ScoringResult,
  enrichment?: CategorizationEnrichment
): TriageReport {
  const createdDate = toCreatedDate(config.generatedAt);
  const runId = toRunId(createdDate);
  const runWikiLink = `[[${runId}]]`;
  const itemTypeByNumber = new Map<number, TriageItemType>();
  for (const item of scoring.issues) {
    itemTypeByNumber.set(item.number, item.type);
  }
  for (const item of scoring.prs) {
    itemTypeByNumber.set(item.number, item.type);
  }

  const issueItems = toReportItems(scoring.issues, itemTypeByNumber);
  const prItems = toReportItems(scoring.prs, itemTypeByNumber);
  const rendered = renderRunBody(config, runWikiLink, issueItems, prItems, enrichment);
  const snapshot = buildSnapshot(config, runId, runWikiLink, issueItems, prItems);

  return {
    markdown: rendered.markdown,
    sections: {
      issues: rendered.issuesSection,
      prs: rendered.prsSection,
    },
    runId,
    runWikiLink,
    items: {
      issues: issueItems,
      prs: prItems,
    },
    snapshot,
  };
}

export async function writeTriageArtifacts(
  config: TriageConfig,
  report: TriageReport,
  options: WriteTriageArtifactsOptions = {}
): Promise<TriageArtifactPaths> {
  const createdDate = toCreatedDate(config.generatedAt);
  const rootDir = options.outputRootDir ?? DEFAULT_TRIAGE_OUTPUT_ROOT;
  const issuesDir = path.join(rootDir, "issues");
  const prsDir = path.join(rootDir, "prs");

  await fs.mkdir(issuesDir, { recursive: true });
  await fs.mkdir(prsDir, { recursive: true });

  const issueItemPaths = await writeItemArtifacts(
    report.items.issues,
    issuesDir,
    createdDate,
    report.runWikiLink
  );
  const prItemPaths = await writeItemArtifacts(
    report.items.prs,
    prsDir,
    createdDate,
    report.runWikiLink
  );

  const runReportPath = path.join(rootDir, `${report.runId}.md`);
  const snapshotPath = path.join(rootDir, `${report.runId}.snapshot.json`);

  const runRelatedLinks = [
    report.runWikiLink,
    ...report.items.issues.map((item) => item.wikiLink),
    ...report.items.prs.map((item) => item.wikiLink),
  ];
  const runFrontMatter = buildFrontMatter({
    type: "report",
    title: `${report.runId} ranked triage`,
    created: createdDate,
    tags: ["triage", "issue-pr-bot", "run-report"],
    related: Array.from(new Set(runRelatedLinks)),
  });

  await fs.writeFile(runReportPath, `${runFrontMatter}${report.markdown}\n`, "utf-8");
  await fs.writeFile(
    snapshotPath,
    `${JSON.stringify(report.snapshot, null, 2)}\n`,
    "utf-8"
  );

  return {
    rootDir,
    runReportPath,
    snapshotPath,
    issueItemPaths,
    prItemPaths,
  };
}
