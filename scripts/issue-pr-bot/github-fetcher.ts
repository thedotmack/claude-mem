import { execSync } from "child_process";
import type { NormalizedItem, TriageConfig } from "./types.ts";

interface GitHubCliAuthor {
  login: string;
}

interface GitHubCliLabel {
  name: string;
}

interface GitHubCliAssignee {
  login: string;
}

interface GitHubCliIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  author: GitHubCliAuthor;
  labels: GitHubCliLabel[];
  assignees: GitHubCliAssignee[];
  createdAt: string;
  updatedAt: string;
}

interface GitHubCliPullRequest extends GitHubCliIssue {
  mergeable: string;
  reviewDecision: string;
  headRefName: string;
  baseRefName: string;
}

function mapIssueToNormalizedItem(issue: GitHubCliIssue): NormalizedItem {
  return {
    id: issue.number,
    number: issue.number,
    type: "issue",
    title: issue.title ?? "(untitled)",
    body: issue.body ?? "",
    links: {
      html: issue.url,
      api: "",
    },
    htmlUrl: issue.url,
    author: issue.author ? { login: issue.author.login } : null,
    labels: (issue.labels ?? []).map((label) => ({ name: label.name })),
    assignees: (issue.assignees ?? []).map((assignee) => ({
      login: assignee.login,
    })),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    pullRequest: null,
  };
}

function mapPullRequestToNormalizedItem(
  pullRequest: GitHubCliPullRequest
): NormalizedItem {
  return {
    id: pullRequest.number,
    number: pullRequest.number,
    type: "pr",
    title: pullRequest.title ?? "(untitled)",
    body: pullRequest.body ?? "",
    links: {
      html: pullRequest.url,
      api: "",
    },
    htmlUrl: pullRequest.url,
    author: pullRequest.author
      ? { login: pullRequest.author.login }
      : null,
    labels: (pullRequest.labels ?? []).map((label) => ({ name: label.name })),
    assignees: (pullRequest.assignees ?? []).map((assignee) => ({
      login: assignee.login,
    })),
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    pullRequest: {
      changedFiles: null,
      additions: null,
      deletions: null,
      commits: null,
    },
  };
}

export async function fetchOpenItemsFromGitHub(
  config: TriageConfig
): Promise<NormalizedItem[]> {
  const repoSlug = `${config.repository.owner}/${config.repository.repo}`;

  const issueJsonFields =
    "number,title,body,url,author,labels,assignees,createdAt,updatedAt";
  const prJsonFields =
    "number,title,body,url,author,labels,assignees,createdAt,updatedAt,mergeable,reviewDecision,headRefName,baseRefName";

  const issuesRaw = execSync(
    `gh issue list --repo ${repoSlug} --state open --limit 200 --json ${issueJsonFields}`,
    { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
  );
  const issues: GitHubCliIssue[] = JSON.parse(issuesRaw);

  const prsRaw = execSync(
    `gh pr list --repo ${repoSlug} --state open --limit 200 --json ${prJsonFields}`,
    { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
  );
  const pullRequests: GitHubCliPullRequest[] = JSON.parse(prsRaw);

  const normalizedIssues = issues.map(mapIssueToNormalizedItem);
  const normalizedPullRequests = pullRequests.map(
    mapPullRequestToNormalizedItem
  );

  return [...normalizedIssues, ...normalizedPullRequests];
}
