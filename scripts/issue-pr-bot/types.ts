export type TriageItemType = "issue" | "pr";
export type DiscoveryScope = "open-issues-and-prs";
export type OutputSection = "issues" | "prs";
export type SeverityBucket = "critical" | "high" | "medium" | "low";
export type PriorityBucket = "urgent" | "high" | "normal" | "low";
export type TriageIntent =
  | "bug"
  | "feature"
  | "docs"
  | "maintenance"
  | "refactor"
  | "test"
  | "infra";

export interface RepoTarget {
  owner: string;
  repo: string;
}

export interface TriageConfig {
  repository: RepoTarget;
  discovery: {
    scope: DiscoveryScope;
    outdatedThresholdDays: number;
  };
  output: {
    sections: OutputSection[];
  };
  developerPriorityOrder: string[];
  generatedAt: string;
}

export interface NormalizedUser {
  login: string;
}

export interface NormalizedLabel {
  name: string;
}

export interface NormalizedLinkSet {
  html: string;
  api: string;
}

export interface NormalizedPullRequestStats {
  changedFiles: number | null;
  additions: number | null;
  deletions: number | null;
  commits: number | null;
}

export interface NormalizedItem {
  id: number;
  number: number;
  type: TriageItemType;
  title: string;
  body: string;
  links: NormalizedLinkSet;
  htmlUrl: string;
  author: NormalizedUser | null;
  labels: NormalizedLabel[];
  assignees: NormalizedUser[];
  createdAt: string;
  updatedAt: string;
  pullRequest: NormalizedPullRequestStats | null;
  mergeableState?: string;
  reviewDecision?: string;
  headRefName?: string;
  baseRefName?: string;
}

export type CategoryCluster =
  | "chroma"
  | "process-lifecycle"
  | "windows"
  | "hooks"
  | "installation"
  | "security"
  | "feature-request"
  | "spam"
  | "uncategorized";

export interface CategorizedItem extends NormalizedItem {
  category: CategoryCluster;
}

export interface DuplicateGroup {
  groupId: number;
  canonical: number;
  duplicates: number[];
  reason: string;
}

export interface IngestionResult {
  items: NormalizedItem[];
  warnings: string[];
}

export interface RankedItem extends NormalizedItem {
  intent: TriageIntent;
  severityBucket: SeverityBucket;
  priorityBucket: PriorityBucket;
  score: number;
  rank: number;
  inactivityDays: number;
  outdatedCandidate: boolean;
  outdatedReasons: string[];
  developerPriorityBoost: number;
}

export interface ScoringResult {
  issues: RankedItem[];
  prs: RankedItem[];
}

export interface DraftExecutionPlan {
  nextSteps: string[];
  risks: string[];
  validationChecks: string[];
}

export interface TriageReportItem {
  number: number;
  type: TriageItemType;
  title: string;
  htmlUrl: string;
  rank: number;
  score: number;
  intent: TriageIntent;
  severityBucket: SeverityBucket;
  priorityBucket: PriorityBucket;
  inactivityDays: number;
  outdatedCandidate: boolean;
  outdatedReasons: string[];
  wikiLink: string;
  relatedWikiLinks: string[];
  draftPlan: DraftExecutionPlan | null;
  authorLogin: string | null;
  mergeableState?: string;
  reviewDecision?: string;
}

export interface TriageSnapshot {
  runId: string;
  runWikiLink: string;
  generatedAt: string;
  repository: RepoTarget;
  summary: {
    totalIssues: number;
    totalPullRequests: number;
    outdatedIssueCandidates: number;
    outdatedPullRequestCandidates: number;
  };
  sections: {
    issues: TriageReportItem[];
    prs: TriageReportItem[];
  };
}

export interface TriageArtifactPaths {
  rootDir: string;
  runReportPath: string;
  snapshotPath: string;
  issueItemPaths: string[];
  prItemPaths: string[];
}

export type TriageAction =
  | "close-outdated"
  | "close-duplicate"
  | "close-spam"
  | "merge-into-tracking"
  | "assign-developer"
  | "keep-as-is"
  | "needs-rebase"
  | "ready-to-merge";

export interface TriageRecommendation {
  itemNumber: number;
  action: TriageAction;
  reason: string;
  targetIssue?: number;
  assignTo?: string;
}

export interface TriageRecommendationsResult {
  recommendations: TriageRecommendation[];
  closeCandidates: TriageRecommendation[];
  mergeCandidates: TriageRecommendation[];
  assignmentMap: Record<string, number[]>;
}

export type EstimatedEffort = "small" | "medium" | "large";

export interface ActionPlan {
  itemNumber: number;
  title: string;
  category: CategoryCluster;
  severity: SeverityBucket;
  priority: PriorityBucket;
  assignedTo: string;
  summary: string;
  likelyFiles: string[];
  nextStep: string;
  estimatedEffort: EstimatedEffort;
}

export interface ActionPlanReport {
  plans: ActionPlan[];
  byDeveloper: Record<string, ActionPlan[]>;
  byCategory: Record<string, ActionPlan[]>;
  bySeverity: Record<string, ActionPlan[]>;
}

export interface TriageResult {
  config: TriageConfig;
  ingestion: IngestionResult;
  scoring: ScoringResult;
  report: TriageReport;
  categorized: CategorizedItem[];
  duplicateGroups: DuplicateGroup[];
  recommendations: TriageRecommendationsResult;
  actionPlans?: ActionPlanReport;
}

export interface TriageReport {
  markdown: string;
  sections: {
    issues: string;
    prs: string;
  };
  runId: string;
  runWikiLink: string;
  items: {
    issues: TriageReportItem[];
    prs: TriageReportItem[];
  };
  snapshot: TriageSnapshot;
  artifacts?: TriageArtifactPaths;
}
