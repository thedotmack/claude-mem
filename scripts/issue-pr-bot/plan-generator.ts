import {
  resolveIntent,
  resolvePriorityBucket,
  resolveSeverityBucket,
  toNormalizedLabels,
  toSearchableText,
} from "./scoring.ts";
import type {
  ActionPlan,
  ActionPlanReport,
  CategorizedItem,
  CategoryCluster,
  EstimatedEffort,
  SeverityBucket,
  TriageAction,
  TriageConfig,
  TriageRecommendation,
  TriageRecommendationsResult,
} from "./types.ts";

const CLOSE_ACTIONS: Set<TriageAction> = new Set([
  "close-outdated",
  "close-duplicate",
  "close-spam",
]);

const CATEGORY_LIKELY_FILES: Record<string, string[]> = {
  chroma: ["src/services/sync/ChromaSync.ts", "src/services/chroma/"],
  "process-lifecycle": [
    "src/services/infrastructure/ProcessManager.ts",
    "src/services/worker-service.ts",
  ],
  windows: ["src/utils/platform.ts", "plugin/scripts/setup.sh"],
  hooks: ["src/hooks/", "plugin/hooks/hooks.json"],
  installation: ["installer/src/", "plugin/scripts/setup.sh"],
  security: ["src/", "plugin/"],
  "feature-request": ["src/"],
};

const DAY_IN_MS = 24 * 60 * 60 * 1000;

function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/[#*_~>[\]()!|]/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function generateSummary(item: CategorizedItem): string {
  const bodyText = item.body.trim();
  if (bodyText.length === 0) {
    return item.title;
  }
  const cleaned = stripMarkdownFormatting(bodyText);
  if (cleaned.length <= 200) {
    return cleaned;
  }
  return `${cleaned.slice(0, 200)}...`;
}

function resolveLikelyFiles(category: CategoryCluster): string[] {
  return CATEGORY_LIKELY_FILES[category] ?? ["src/"];
}

function resolveEstimatedEffort(
  severity: SeverityBucket,
  bodyLength: number
): EstimatedEffort {
  if (severity === "critical" || bodyLength > 500) {
    return "large";
  }
  if (severity === "high" || bodyLength > 200) {
    return "medium";
  }
  return "small";
}

function resolveNextStep(
  item: CategorizedItem,
  intent: string,
  recommendation: TriageRecommendation | undefined,
  likelyFiles: string[]
): string {
  if (recommendation?.action === "needs-rebase") {
    return "Rebase onto main, resolve conflicts, re-run tests";
  }
  if (recommendation?.action === "ready-to-merge") {
    return "Review final changes, merge, verify in production";
  }

  const filesDescription =
    likelyFiles.length > 0 ? likelyFiles.join(", ") : "relevant source files";

  if (item.type === "pr") {
    return `Review PR changes in ${filesDescription}, ensure tests pass, then merge`;
  }

  if (intent === "feature") {
    return "Define scope and acceptance criteria, then implement";
  }

  return `Reproduce the issue, identify root cause in ${filesDescription}, implement fix`;
}

function resolveAssignedTo(
  itemNumber: number,
  recommendations: TriageRecommendation[]
): string {
  const recommendation = recommendations.find(
    (r) => r.itemNumber === itemNumber
  );
  return recommendation?.assignTo ?? "unassigned";
}

export function generateActionPlans(
  categorized: CategorizedItem[],
  recommendations: TriageRecommendationsResult,
  config: TriageConfig
): ActionPlanReport {
  const closedItemNumbers = new Set(
    recommendations.recommendations
      .filter((r) => CLOSE_ACTIONS.has(r.action))
      .map((r) => r.itemNumber)
  );

  const recommendationByItem = new Map<number, TriageRecommendation>();
  for (const rec of recommendations.recommendations) {
    recommendationByItem.set(rec.itemNumber, rec);
  }

  const survivingItems = categorized.filter(
    (item) => !closedItemNumbers.has(item.number)
  );

  const nowTimestamp = Date.parse(config.generatedAt) || Date.now();

  const plans: ActionPlan[] = survivingItems.map((item) => {
    const text = toSearchableText(item);
    const labels = toNormalizedLabels(item);
    const intent = resolveIntent(item, text, labels);
    const severity = resolveSeverityBucket(item, intent, text, labels);
    const updatedTimestamp = Date.parse(item.updatedAt);
    const inactivityDays = Number.isNaN(updatedTimestamp)
      ? 0
      : Math.max(0, Math.floor((nowTimestamp - updatedTimestamp) / DAY_IN_MS));
    const priority = resolvePriorityBucket(
      item,
      severity,
      intent,
      text,
      labels,
      inactivityDays,
      config.developerPriorityOrder
    );
    const likelyFiles = resolveLikelyFiles(item.category);
    const recommendation = recommendationByItem.get(item.number);

    return {
      itemNumber: item.number,
      title: item.title,
      category: item.category,
      severity,
      priority,
      assignedTo: resolveAssignedTo(
        item.number,
        recommendations.recommendations
      ),
      summary: generateSummary(item),
      likelyFiles,
      nextStep: resolveNextStep(item, intent, recommendation, likelyFiles),
      estimatedEffort: resolveEstimatedEffort(severity, item.body.length),
    };
  });

  const byDeveloper: Record<string, ActionPlan[]> = {};
  const byCategory: Record<string, ActionPlan[]> = {};
  const bySeverity: Record<string, ActionPlan[]> = {};

  for (const plan of plans) {
    const developerPlans = byDeveloper[plan.assignedTo] ?? [];
    developerPlans.push(plan);
    byDeveloper[plan.assignedTo] = developerPlans;

    const categoryPlans = byCategory[plan.category] ?? [];
    categoryPlans.push(plan);
    byCategory[plan.category] = categoryPlans;

    const severityPlans = bySeverity[plan.severity] ?? [];
    severityPlans.push(plan);
    bySeverity[plan.severity] = severityPlans;
  }

  return { plans, byDeveloper, byCategory, bySeverity };
}
