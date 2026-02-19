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

export interface TriageReport {
  markdown: string;
  sections: {
    issues: string;
    prs: string;
  };
}
