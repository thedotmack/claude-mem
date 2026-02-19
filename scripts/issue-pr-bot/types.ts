export type TriageItemType = "issue" | "pr";

export interface RepoTarget {
  owner: string;
  repo: string;
}

export interface TriageConfig {
  repository: RepoTarget;
  generatedAt: string;
}

export interface NormalizedUser {
  login: string;
}

export interface NormalizedLabel {
  name: string;
}

export interface NormalizedItem {
  id: number;
  number: number;
  type: TriageItemType;
  title: string;
  body: string;
  htmlUrl: string;
  author: NormalizedUser | null;
  labels: NormalizedLabel[];
  assignees: NormalizedUser[];
  createdAt: string;
  updatedAt: string;
}

export interface IngestionResult {
  items: NormalizedItem[];
  warnings: string[];
}

export interface RankedItem extends NormalizedItem {
  score: number;
  rank: number;
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
