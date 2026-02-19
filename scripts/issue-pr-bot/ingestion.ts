import type {
  IngestionResult,
  NormalizedItem,
  NormalizedLabel,
  NormalizedPullRequestStats,
  NormalizedUser,
  TriageConfig,
  TriageItemType,
} from "./types.ts";

export interface IngestionDependencies {
  fetchOpenItems?: (config: TriageConfig) => Promise<NormalizedItem[]>;
  apiFetch?: typeof fetch;
  githubToken?: string | null;
}

interface GitHubUserRecord {
  login?: string;
}

interface GitHubLabelRecord {
  name?: string;
}

interface GitHubIssueRecord {
  id?: number;
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  url?: string;
  user?: GitHubUserRecord | null;
  labels?: Array<GitHubLabelRecord | string>;
  assignees?: GitHubUserRecord[];
  created_at?: string;
  updated_at?: string;
  pull_request?: {
    url?: string;
  };
}

interface GitHubPullRequestRecord {
  changed_files?: number;
  additions?: number;
  deletions?: number;
  commits?: number;
}

interface GitHubRequestContext {
  apiFetch: typeof fetch;
  token: string | null;
  warnings: Set<string>;
}

const GITHUB_API_BASE_URL = "https://api.github.com";
const PER_PAGE = 100;
const PR_DETAIL_BATCH_SIZE = 8;
const GITHUB_API_ACCEPT_HEADER = "application/vnd.github+json";
const GITHUB_API_VERSION = "2022-11-28";

export const MISSING_AUTH_WARNING =
  "GitHub auth token not found (GITHUB_TOKEN or GH_TOKEN). Using public API mode with lower rate limits.";
export const AUTH_FALLBACK_WARNING =
  "GitHub authenticated API request was rate-limited; retrying in public API mode.";
export const PUBLIC_RATE_LIMIT_WARNING =
  "GitHub public API rate limit was reached; ingestion may be incomplete.";

function readTokenFromEnvironment(): string | null {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    return null;
  }

  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUser(input?: GitHubUserRecord | null): NormalizedUser | null {
  if (!input?.login) {
    return null;
  }

  return { login: input.login };
}

function normalizeLabels(
  labels?: Array<GitHubLabelRecord | string>
): NormalizedLabel[] {
  if (!labels || labels.length === 0) {
    return [];
  }

  return labels
    .map((label) => {
      if (typeof label === "string") {
        return { name: label };
      }

      if (label?.name) {
        return { name: label.name };
      }

      return null;
    })
    .filter((label): label is NormalizedLabel => label !== null);
}

function isPullRequestRecord(record: GitHubIssueRecord): boolean {
  return Boolean(record.pull_request);
}

function toSafeIsoDate(input: string | undefined, fallback: string): string {
  if (!input) {
    return fallback;
  }

  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return fallback;
  }

  return new Date(timestamp).toISOString();
}

function toNormalizedPrStats(
  details?: GitHubPullRequestRecord
): NormalizedPullRequestStats {
  return {
    changedFiles:
      typeof details?.changed_files === "number" ? details.changed_files : null,
    additions: typeof details?.additions === "number" ? details.additions : null,
    deletions: typeof details?.deletions === "number" ? details.deletions : null,
    commits: typeof details?.commits === "number" ? details.commits : null,
  };
}

function normalizeIssueRecord(
  config: TriageConfig,
  record: GitHubIssueRecord
): NormalizedItem {
  const type: TriageItemType = isPullRequestRecord(record) ? "pr" : "issue";
  const fallbackNumber = typeof record.number === "number" ? record.number : 0;
  const fallbackHtmlUrl = `https://github.com/${config.repository.owner}/${config.repository.repo}/${
    type === "pr" ? "pull" : "issues"
  }/${fallbackNumber}`;
  const fallbackApiUrl = `${GITHUB_API_BASE_URL}/repos/${config.repository.owner}/${config.repository.repo}/issues/${fallbackNumber}`;

  return {
    id: typeof record.id === "number" ? record.id : fallbackNumber,
    number: fallbackNumber,
    type,
    title: record.title ?? "(untitled)",
    body: record.body ?? "",
    links: {
      html: record.html_url ?? fallbackHtmlUrl,
      api: record.url ?? fallbackApiUrl,
    },
    htmlUrl: record.html_url ?? fallbackHtmlUrl,
    author: normalizeUser(record.user),
    labels: normalizeLabels(record.labels),
    assignees:
      record.assignees?.map(normalizeUser).filter((value): value is NormalizedUser =>
        value !== null
      ) ?? [],
    createdAt: toSafeIsoDate(record.created_at, config.generatedAt),
    updatedAt: toSafeIsoDate(record.updated_at, config.generatedAt),
    pullRequest: type === "pr" ? toNormalizedPrStats() : null,
  };
}

function buildRequestHeaders(token: string | null): HeadersInit {
  if (!token) {
    return {
      Accept: GITHUB_API_ACCEPT_HEADER,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
  }

  return {
    Accept: GITHUB_API_ACCEPT_HEADER,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    Authorization: `Bearer ${token}`,
  };
}

async function parseErrorMessage(response: Response): Promise<string> {
  const bodyText = await response.text();
  if (!bodyText) {
    return "No response body";
  }

  try {
    const parsed = JSON.parse(bodyText) as { message?: string };
    if (parsed.message) {
      return parsed.message;
    }
  } catch (_error) {
    // Ignore parse errors and return raw text.
  }

  return bodyText.slice(0, 280);
}

function shouldRetryWithoutAuth(
  response: Response,
  errorMessage: string
): boolean {
  if (response.status === 401 || response.status === 429) {
    return true;
  }

  if (response.status !== 403) {
    return false;
  }

  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining === "0") {
    return true;
  }

  return errorMessage.toLowerCase().includes("rate limit");
}

async function requestGitHubJson<T>(
  context: GitHubRequestContext,
  path: string
): Promise<T> {
  const endpoint = `${GITHUB_API_BASE_URL}${path}`;
  let activeToken = context.token;
  let hasRetriedWithoutAuth = false;

  while (true) {
    const response = await context.apiFetch(endpoint, {
      headers: buildRequestHeaders(activeToken),
    });

    if (response.ok) {
      return (await response.json()) as T;
    }

    const errorMessage = await parseErrorMessage(response);
    const canRetryWithoutAuth =
      activeToken !== null &&
      !hasRetriedWithoutAuth &&
      shouldRetryWithoutAuth(response, errorMessage);

    if (canRetryWithoutAuth) {
      context.warnings.add(AUTH_FALLBACK_WARNING);
      activeToken = null;
      hasRetriedWithoutAuth = true;
      continue;
    }

    if (activeToken === null && shouldRetryWithoutAuth(response, errorMessage)) {
      context.warnings.add(PUBLIC_RATE_LIMIT_WARNING);
    }

    throw new Error(
      `GitHub API request failed (${response.status}) for ${path}: ${errorMessage}`
    );
  }
}

async function fetchOpenIssueRecords(
  config: TriageConfig,
  context: GitHubRequestContext
): Promise<GitHubIssueRecord[]> {
  const allItems: GitHubIssueRecord[] = [];
  const owner = encodeURIComponent(config.repository.owner);
  const repo = encodeURIComponent(config.repository.repo);

  let page = 1;
  while (true) {
    const path =
      `/repos/${owner}/${repo}/issues?state=open` +
      `&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`;
    const pageItems = await requestGitHubJson<GitHubIssueRecord[]>(context, path);
    allItems.push(...pageItems);

    if (pageItems.length < PER_PAGE) {
      break;
    }

    page += 1;
  }

  return allItems;
}

async function fetchPullRequestDetails(
  config: TriageConfig,
  context: GitHubRequestContext,
  number: number
): Promise<GitHubPullRequestRecord> {
  const owner = encodeURIComponent(config.repository.owner);
  const repo = encodeURIComponent(config.repository.repo);
  const path = `/repos/${owner}/${repo}/pulls/${number}`;
  return requestGitHubJson<GitHubPullRequestRecord>(context, path);
}

async function enrichPullRequestItems(
  config: TriageConfig,
  context: GitHubRequestContext,
  items: NormalizedItem[]
): Promise<void> {
  const pullRequestItems = items.filter((item) => item.type === "pr");

  for (let index = 0; index < pullRequestItems.length; index += PR_DETAIL_BATCH_SIZE) {
    const batch = pullRequestItems.slice(index, index + PR_DETAIL_BATCH_SIZE);

    await Promise.all(
      batch.map(async (item) => {
        try {
          const details = await fetchPullRequestDetails(config, context, item.number);
          item.pullRequest = toNormalizedPrStats(details);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          context.warnings.add(
            `Failed to fetch PR stats for #${item.number}: ${message}`
          );
        }
      })
    );
  }
}

export async function ingestOpenItems(
  config: TriageConfig,
  dependencies: IngestionDependencies = {}
): Promise<IngestionResult> {
  if (dependencies.fetchOpenItems) {
    const items = await dependencies.fetchOpenItems(config);
    return {
      items,
      warnings: [],
    };
  }

  const warnings = new Set<string>();
  const token = dependencies.githubToken ?? readTokenFromEnvironment();

  if (!token) {
    warnings.add(MISSING_AUTH_WARNING);
  }

  const context: GitHubRequestContext = {
    apiFetch: dependencies.apiFetch ?? fetch,
    token,
    warnings,
  };

  try {
    const openRecords = await fetchOpenIssueRecords(config, context);
    const items = openRecords.map((record) => normalizeIssueRecord(config, record));
    await enrichPullRequestItems(config, context, items);

    return {
      items,
      warnings: [...warnings],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.add(`Failed to ingest open issues/PRs: ${message}`);

    return {
      items: [],
      warnings: [...warnings],
    };
  }
}
