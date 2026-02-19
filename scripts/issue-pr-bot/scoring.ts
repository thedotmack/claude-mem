import {
  DEFAULT_DEVELOPER_PRIORITY_ORDER,
  DEFAULT_OUTDATED_THRESHOLD_DAYS,
} from "./config.ts";
import type {
  NormalizedItem,
  PriorityBucket,
  RankedItem,
  ScoringResult,
  SeverityBucket,
  TriageIntent,
  TriageItemType,
} from "./types.ts";

export const SEVERITY_BUCKET_ORDER = Object.freeze<SeverityBucket[]>([
  "critical",
  "high",
  "medium",
  "low",
]);
export const PRIORITY_BUCKET_ORDER = Object.freeze<PriorityBucket[]>([
  "urgent",
  "high",
  "normal",
  "low",
]);

export const SEVERITY_BUCKET_WEIGHTS: Record<SeverityBucket, number> =
  Object.freeze({
    critical: 4_000,
    high: 3_000,
    medium: 2_000,
    low: 1_000,
  });
export const PRIORITY_BUCKET_WEIGHTS: Record<PriorityBucket, number> =
  Object.freeze({
    urgent: 400,
    high: 300,
    normal: 200,
    low: 100,
  });

export const TRIAGE_INTENT_ORDER = Object.freeze<TriageIntent[]>([
  "bug",
  "feature",
  "infra",
  "maintenance",
  "refactor",
  "test",
  "docs",
]);

export const TRIAGE_INTENT_WEIGHTS: Record<TriageIntent, number> = Object.freeze({
  bug: 170,
  feature: 140,
  infra: 135,
  maintenance: 120,
  refactor: 105,
  test: 95,
  docs: 80,
});

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const BASE_DEVELOPER_BOOST = 60;
const ASSIGNEE_BOOST_FACTOR = 0.5;
const OUTDATED_PENALTY = 450;
const FRESHNESS_BOOST_MAX = 140;
const PR_COMPLEXITY_BOOST_MAX = 140;

interface ScoringOptions {
  now?: Date | string;
  outdatedThresholdDays?: number;
  developerPriorityOrder?: string[];
}

interface OutdatedAnalysis {
  inactivityDays: number;
  outdatedCandidate: boolean;
  outdatedReasons: string[];
}

interface IntentSignals {
  labelKeywords: string[];
  textPatterns: RegExp[];
}

const INTENT_SIGNAL_DEFINITIONS: Record<TriageIntent, IntentSignals> = {
  bug: {
    labelKeywords: ["bug", "regression", "fix", "defect"],
    textPatterns: [
      /\bbug\b/,
      /\bregression\b/,
      /\berror\b/,
      /\bfail(?:ing|ure)?\b/,
      /\bcrash(?:ing|ed|es)?\b/,
      /\bbroken\b/,
    ],
  },
  feature: {
    labelKeywords: ["feature", "enhancement", "proposal", "request"],
    textPatterns: [/\bfeature\b/, /\benhancement\b/, /\brequest\b/, /\badd\b/, /\bsupport\b/],
  },
  docs: {
    labelKeywords: ["docs", "documentation", "readme"],
    textPatterns: [/\bdocs?\b/, /\bdocumentation\b/, /\breadme\b/, /\bguide\b/],
  },
  maintenance: {
    labelKeywords: ["chore", "maintenance", "dependencies", "dependency", "cleanup"],
    textPatterns: [/\bmaintenance\b/, /\bchore\b/, /\bupgrade\b/, /\bdependency\b/, /\bupdate\b/],
  },
  refactor: {
    labelKeywords: ["refactor", "cleanup", "tech debt"],
    textPatterns: [/\brefactor\b/, /\brestructure\b/, /\bcleanup\b/, /\btech debt\b/],
  },
  test: {
    labelKeywords: ["test", "tests", "qa"],
    textPatterns: [/\btest(?:s|ing)?\b/, /\bunit test\b/, /\bintegration test\b/, /\be2e\b/],
  },
  infra: {
    labelKeywords: ["infra", "ci", "build", "release", "workflow", "devops"],
    textPatterns: [/\bci\b/, /\bworkflow\b/, /\bbuild\b/, /\brelease\b/, /\bdocker\b/, /\binfra\b/],
  },
};

const CRITICAL_LABEL_KEYWORDS = ["critical", "p0", "sev1", "security", "blocker"];
const HIGH_LABEL_KEYWORDS = [
  "high",
  "p1",
  "sev2",
  "regression",
  "urgent",
  "hotfix",
];
const LOW_LABEL_KEYWORDS = [
  "low",
  "p4",
  "p3",
  "minor",
  "trivial",
  "good first issue",
];

const CRITICAL_TEXT_PATTERNS = [
  /\bsecurity\b/,
  /\bvulnerability\b/,
  /\bdata loss\b/,
  /\brce\b/,
  /\bremote code execution\b/,
  /\bprivilege escalation\b/,
  /\bproduction down\b/,
  /\boutage\b/,
  /\bfails? to start\b/,
  /\bcannot start\b/,
];
const HIGH_TEXT_PATTERNS = [
  /\bregression\b/,
  /\bcrash(?:ing|ed|es)?\b/,
  /\bpanic\b/,
  /\bbroken\b/,
  /\bfail(?:ing|ure)?\b/,
  /\btimeout\b/,
  /\bhang(?:ing)?\b/,
];
const LOW_TEXT_PATTERNS = [/\btypo\b/, /\bwording\b/, /\bnit\b/, /\bdocs only\b/];

const URGENT_LABEL_KEYWORDS = [
  "urgent",
  "asap",
  "priority:critical",
  "priority/high",
  "p0",
  "p1",
  "hotfix",
];
const HIGH_PRIORITY_LABEL_KEYWORDS = [
  "priority:high",
  "high-priority",
  "important",
  "needs triage",
  "needs-triage",
];
const LOW_PRIORITY_LABEL_KEYWORDS = [
  "priority:low",
  "low-priority",
  "backlog",
  "nice to have",
  "nice-to-have",
  "p4",
];

const URGENT_TEXT_PATTERNS = [/\burgent\b/, /\basap\b/, /\bimmediately\b/];
const HIGH_PRIORITY_TEXT_PATTERNS = [/\bhigh priority\b/, /\bimportant\b/, /\bneeds triage\b/];
const LOW_PRIORITY_TEXT_PATTERNS = [/\bbacklog\b/, /\bnice to have\b/, /\blower priority\b/];

const SUPERSEDED_LABEL_KEYWORDS = ["duplicate", "superseded", "replaced-by"];
const RESOLVED_LABEL_KEYWORDS = [
  "resolved",
  "fixed",
  "already-fixed",
  "wontfix",
  "invalid",
  "completed",
  "done",
  "closed",
];
const STALE_LABEL_KEYWORDS = ["stale", "inactive"];

const SUPERSEDED_TEXT_PATTERNS = [
  /\bsuperseded by\s+#\d+\b/,
  /\bduplicate of\s+#\d+\b/,
  /\breplaced by\s+#\d+\b/,
  /\btracked in\s+#\d+\b/,
  /\bfollow-?up in\s+#\d+\b/,
  /\buse\s+#\d+\s+instead\b/,
];
const RESOLVED_TEXT_PATTERNS = [
  /\bfixed by\s+#\d+\b/,
  /\bresolved by\s+#\d+\b/,
  /\bclosed by\s+#\d+\b/,
  /\balready fixed\b/,
  /\bno longer reproducible\b/,
  /\bcannot reproduce\b/,
  /\bmerged in\s+#\d+\b/,
  /\blanded in\s+#\d+\b/,
  /\bthis is fixed\b/,
];

function toTimestamp(isoDate: string): number {
  const value = Date.parse(isoDate);
  return Number.isNaN(value) ? 0 : value;
}

function toNowTimestamp(input?: Date | string): number {
  if (!input) {
    return Date.now();
  }

  if (input instanceof Date) {
    return input.getTime();
  }

  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function toSearchableText(item: NormalizedItem): string {
  return `${item.title}\n${item.body}`.toLowerCase();
}

function toNormalizedLabels(item: NormalizedItem): string[] {
  return item.labels.map((label) => label.name.toLowerCase());
}

function countLabelKeywordMatches(
  labels: string[],
  keywords: string[]
): number {
  const labelMatchesKeyword = (label: string, keyword: string): boolean => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`);
    return pattern.test(label);
  };

  let count = 0;
  for (const keyword of keywords) {
    if (labels.some((label) => labelMatchesKeyword(label, keyword))) {
      count += 1;
    }
  }

  return count;
}

function countTextPatternMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      count += 1;
    }
  }

  return count;
}

function hasLabelKeyword(labels: string[], keywords: string[]): boolean {
  return countLabelKeywordMatches(labels, keywords) > 0;
}

function hasTextPattern(text: string, patterns: RegExp[]): boolean {
  return countTextPatternMatches(text, patterns) > 0;
}

export function resolveIntent(
  item: NormalizedItem,
  text: string,
  labels: string[]
): TriageIntent {
  let resolvedIntent: TriageIntent = item.type === "issue" ? "bug" : "maintenance";
  let bestScore = 0;

  for (const intent of TRIAGE_INTENT_ORDER) {
    const signals = INTENT_SIGNAL_DEFINITIONS[intent];
    const labelScore = countLabelKeywordMatches(labels, signals.labelKeywords) * 30;
    const textScore = countTextPatternMatches(text, signals.textPatterns) * 12;
    const score = labelScore + textScore;

    if (score > bestScore) {
      bestScore = score;
      resolvedIntent = intent;
      continue;
    }

    if (score === bestScore && score > 0) {
      const currentRank = TRIAGE_INTENT_ORDER.indexOf(intent);
      const existingRank = TRIAGE_INTENT_ORDER.indexOf(resolvedIntent);
      if (currentRank < existingRank) {
        resolvedIntent = intent;
      }
    }
  }

  return resolvedIntent;
}

export function resolveSeverityBucket(
  item: NormalizedItem,
  intent: TriageIntent,
  text: string,
  labels: string[]
): SeverityBucket {
  if (
    hasLabelKeyword(labels, CRITICAL_LABEL_KEYWORDS) ||
    hasTextPattern(text, CRITICAL_TEXT_PATTERNS)
  ) {
    return "critical";
  }

  if (
    hasLabelKeyword(labels, HIGH_LABEL_KEYWORDS) ||
    hasTextPattern(text, HIGH_TEXT_PATTERNS)
  ) {
    return "high";
  }

  if (
    hasLabelKeyword(labels, LOW_LABEL_KEYWORDS) ||
    hasTextPattern(text, LOW_TEXT_PATTERNS)
  ) {
    return "low";
  }

  if (intent === "docs" || intent === "test") {
    return "low";
  }

  if (
    item.type === "pr" &&
    typeof item.pullRequest?.changedFiles === "number" &&
    item.pullRequest.changedFiles >= 120
  ) {
    return "high";
  }

  return "medium";
}

export function resolvePriorityBucket(
  severityBucket: SeverityBucket,
  intent: TriageIntent,
  text: string,
  labels: string[],
  inactivityDays: number
): PriorityBucket {
  if (severityBucket === "critical") {
    return "urgent";
  }

  if (
    hasLabelKeyword(labels, URGENT_LABEL_KEYWORDS) ||
    hasTextPattern(text, URGENT_TEXT_PATTERNS)
  ) {
    return "urgent";
  }

  if (
    hasLabelKeyword(labels, HIGH_PRIORITY_LABEL_KEYWORDS) ||
    hasTextPattern(text, HIGH_PRIORITY_TEXT_PATTERNS)
  ) {
    return "high";
  }

  if (
    hasLabelKeyword(labels, LOW_PRIORITY_LABEL_KEYWORDS) ||
    hasTextPattern(text, LOW_PRIORITY_TEXT_PATTERNS)
  ) {
    return "low";
  }

  if (severityBucket === "high" || intent === "bug" || intent === "infra") {
    return "high";
  }

  if (inactivityDays > 180) {
    return "low";
  }

  return "normal";
}

function toNormalizedLogin(login: string): string {
  return login.trim().toLowerCase();
}

function resolveDeveloperPriorityBoost(
  item: NormalizedItem,
  developerPriorityOrder: string[]
): number {
  const normalizedOrder = developerPriorityOrder
    .map(toNormalizedLogin)
    .filter((login) => login.length > 0);
  const developerWeights = new Map<string, number>();
  const orderLength = normalizedOrder.length;

  normalizedOrder.forEach((login, index) => {
    developerWeights.set(login, (orderLength - index) * BASE_DEVELOPER_BOOST);
  });

  const authorBoost = item.author
    ? developerWeights.get(toNormalizedLogin(item.author.login)) ?? 0
    : 0;
  const assigneeBoostSource = item.assignees.reduce((maxValue, assignee) => {
    const assigneeBoost =
      developerWeights.get(toNormalizedLogin(assignee.login)) ?? 0;
    return Math.max(maxValue, assigneeBoost);
  }, 0);
  const assigneeBoost = Math.floor(assigneeBoostSource * ASSIGNEE_BOOST_FACTOR);

  return authorBoost + assigneeBoost;
}

function resolveOutdatedAnalysis(
  item: NormalizedItem,
  thresholdDays: number,
  text: string,
  labels: string[],
  nowTimestamp: number
): OutdatedAnalysis {
  const updatedAtTimestamp = toTimestamp(item.updatedAt);
  const safeUpdatedTimestamp =
    updatedAtTimestamp > 0 ? updatedAtTimestamp : nowTimestamp;
  const inactivityDays = Math.max(
    0,
    Math.floor((nowTimestamp - safeUpdatedTimestamp) / DAY_IN_MS)
  );

  const staleByInactivity = inactivityDays >= thresholdDays;
  const hasSupersededSignal =
    hasLabelKeyword(labels, SUPERSEDED_LABEL_KEYWORDS) ||
    hasTextPattern(text, SUPERSEDED_TEXT_PATTERNS);
  const hasResolvedSignal =
    hasLabelKeyword(labels, RESOLVED_LABEL_KEYWORDS) ||
    hasTextPattern(text, RESOLVED_TEXT_PATTERNS);
  const hasStaleLabel = hasLabelKeyword(labels, STALE_LABEL_KEYWORDS);

  const outdatedCandidate =
    staleByInactivity && (hasSupersededSignal || hasResolvedSignal || hasStaleLabel);

  if (!outdatedCandidate) {
    return {
      inactivityDays,
      outdatedCandidate: false,
      outdatedReasons: [],
    };
  }

  const outdatedReasons: string[] = [`inactive-${thresholdDays}-plus-days`];
  if (hasSupersededSignal) {
    outdatedReasons.push("superseded-reference");
  }
  if (hasResolvedSignal) {
    outdatedReasons.push("already-resolved-signal");
  }
  if (hasStaleLabel) {
    outdatedReasons.push("stale-label");
  }

  return {
    inactivityDays,
    outdatedCandidate: true,
    outdatedReasons,
  };
}

function computeFreshnessBoost(
  inactivityDays: number,
  thresholdDays: number
): number {
  const freshnessWindow = Math.max(30, thresholdDays);
  const freshness = Math.max(0, freshnessWindow - inactivityDays);
  return Math.min(FRESHNESS_BOOST_MAX, freshness);
}

function computePullRequestComplexityBoost(item: NormalizedItem): number {
  if (item.type !== "pr") {
    return 0;
  }

  const changedFiles = item.pullRequest?.changedFiles ?? 0;
  const additions = item.pullRequest?.additions ?? 0;
  const deletions = item.pullRequest?.deletions ?? 0;
  const totalLineDelta = additions + deletions;
  let boost = 0;

  if (changedFiles >= 120) {
    boost += 100;
  } else if (changedFiles >= 60) {
    boost += 75;
  } else if (changedFiles >= 20) {
    boost += 50;
  } else if (changedFiles > 0) {
    boost += 20;
  }

  if (totalLineDelta >= 1_000) {
    boost += 40;
  } else if (totalLineDelta >= 400) {
    boost += 25;
  }

  return Math.min(PR_COMPLEXITY_BOOST_MAX, boost);
}

function rankByType(
  items: NormalizedItem[],
  type: TriageItemType,
  options: Required<ScoringOptions>
): RankedItem[] {
  const nowTimestamp = toNowTimestamp(options.now);
  const severityIndexByBucket = new Map<SeverityBucket, number>();
  const priorityIndexByBucket = new Map<PriorityBucket, number>();
  SEVERITY_BUCKET_ORDER.forEach((bucket, index) =>
    severityIndexByBucket.set(bucket, index)
  );
  PRIORITY_BUCKET_ORDER.forEach((bucket, index) =>
    priorityIndexByBucket.set(bucket, index)
  );

  const ranked = items
    .filter((item) => item.type === type)
    .map((item) => {
      const text = toSearchableText(item);
      const labels = toNormalizedLabels(item);
      const intent = resolveIntent(item, text, labels);
      const outdated = resolveOutdatedAnalysis(
        item,
        options.outdatedThresholdDays,
        text,
        labels,
        nowTimestamp
      );
      const severityBucket = resolveSeverityBucket(item, intent, text, labels);
      const priorityBucket = resolvePriorityBucket(
        severityBucket,
        intent,
        text,
        labels,
        outdated.inactivityDays
      );
      const developerPriorityBoost = resolveDeveloperPriorityBoost(
        item,
        options.developerPriorityOrder
      );
      const freshnessBoost = computeFreshnessBoost(
        outdated.inactivityDays,
        options.outdatedThresholdDays
      );
      const pullRequestComplexityBoost = computePullRequestComplexityBoost(item);
      const outdatedPenalty = outdated.outdatedCandidate ? OUTDATED_PENALTY : 0;
      const score =
        SEVERITY_BUCKET_WEIGHTS[severityBucket] +
        PRIORITY_BUCKET_WEIGHTS[priorityBucket] +
        TRIAGE_INTENT_WEIGHTS[intent] +
        developerPriorityBoost +
        freshnessBoost +
        pullRequestComplexityBoost -
        outdatedPenalty;

      return {
        ...item,
        intent,
        severityBucket,
        priorityBucket,
        score,
        rank: 0,
        inactivityDays: outdated.inactivityDays,
        outdatedCandidate: outdated.outdatedCandidate,
        outdatedReasons: outdated.outdatedReasons,
        developerPriorityBoost,
      };
    })
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      const severityDelta =
        (severityIndexByBucket.get(left.severityBucket) ?? 0) -
        (severityIndexByBucket.get(right.severityBucket) ?? 0);
      if (severityDelta !== 0) {
        return severityDelta;
      }

      const priorityDelta =
        (priorityIndexByBucket.get(left.priorityBucket) ?? 0) -
        (priorityIndexByBucket.get(right.priorityBucket) ?? 0);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      if (left.outdatedCandidate !== right.outdatedCandidate) {
        return left.outdatedCandidate ? 1 : -1;
      }

      const updatedDelta = toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt);

      if (updatedDelta !== 0) {
        return updatedDelta;
      }

      const createdDelta = toTimestamp(left.createdAt) - toTimestamp(right.createdAt);
      if (createdDelta !== 0) {
        return createdDelta;
      }

      return left.number - right.number;
    });

  return ranked.map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

export function scoreAndRankItems(
  items: NormalizedItem[],
  options: ScoringOptions = {}
): ScoringResult {
  const resolvedOptions: Required<ScoringOptions> = {
    now: options.now ?? new Date().toISOString(),
    outdatedThresholdDays:
      options.outdatedThresholdDays ?? DEFAULT_OUTDATED_THRESHOLD_DAYS,
    developerPriorityOrder:
      options.developerPriorityOrder ?? [...DEFAULT_DEVELOPER_PRIORITY_ORDER],
  };

  return {
    issues: rankByType(items, "issue", resolvedOptions),
    prs: rankByType(items, "pr", resolvedOptions),
  };
}
