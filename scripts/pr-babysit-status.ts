#!/usr/bin/env bun

import { pathToFileURL } from 'url';

type GhResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type PullRequest = {
  number: number;
  title: string;
  url: string;
  headRefOid: string;
  baseRefName: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
};

type RepoInfo = {
  nameWithOwner: string;
};

type CheckRun = {
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' | string;
  completedAt?: string;
  description?: string;
  link?: string;
  name: string;
  startedAt?: string;
  state: string;
  workflow?: string;
};

type Review = {
  id: number;
  user?: { login?: string };
  state: string;
  body?: string | null;
  commit_id?: string;
  submitted_at?: string;
  html_url?: string;
};

type ReviewComment = {
  user?: { login?: string };
  body?: string | null;
  commit_id?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  updated_at?: string;
  created_at?: string;
  html_url?: string;
};

type BranchProtection = {
  required_status_checks?: {
    strict?: boolean;
    contexts?: string[];
    checks?: Array<{ context?: string; app_id?: number | null }>;
  };
  required_pull_request_reviews?: {
    dismiss_stale_reviews?: boolean;
    require_code_owner_reviews?: boolean;
    require_last_push_approval?: boolean;
    required_approving_review_count?: number;
  };
  required_signatures?: { enabled?: boolean };
  enforce_admins?: { enabled?: boolean };
  required_conversation_resolution?: { enabled?: boolean };
  allow_force_pushes?: { enabled?: boolean };
};

type BotHint = {
  source: string;
  author: string;
  when: string;
  location?: string;
  hints: string[];
};

const GH_PENDING_EXIT_CODE = 8;
const BOT_LOGIN_PATTERN = /(coderabbit|greptile)/i;

function runCommand(cmd: string[]): GhResult {
  try {
    const result = Bun.spawnSync({
      cmd,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    return {
      stdout: new TextDecoder().decode(result.stdout).trim(),
      stderr: new TextDecoder().decode(result.stderr).trim(),
      exitCode: result.exitCode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: '', stderr: message, exitCode: 127 };
  }
}

function runGh(args: string[], options: { allowExitCodes?: number[] } = {}): string {
  const result = runCommand(['gh', ...args]);
  const allowed = new Set([0, ...(options.allowExitCodes ?? [])]);
  if (!allowed.has(result.exitCode)) {
    const detail = result.stderr || result.stdout || `exit code ${result.exitCode}`;
    throw new Error(`gh ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout;
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${label} JSON: ${message}`);
  }
}

function checkPrerequisites() {
  const git = runCommand(['git', 'rev-parse', '--is-inside-work-tree']);
  if (git.exitCode !== 0 || git.stdout.trim() !== 'true') {
    throw new Error('Not in a git repository. Run this from a checked-out repo.');
  }

  const ghVersion = runCommand(['gh', '--version']);
  if (ghVersion.exitCode !== 0) {
    throw new Error('GitHub CLI is not available. Install gh and try again.');
  }

  const auth = runCommand(['gh', 'auth', 'status']);
  if (auth.exitCode !== 0) {
    throw new Error(`GitHub CLI is not authenticated. Run "gh auth login".\n${auth.stderr || auth.stdout}`.trim());
  }
}

function targetArgs(prArg?: string): string[] {
  return prArg ? [prArg] : [];
}

function fetchPr(prArg?: string): PullRequest {
  const fields = [
    'number',
    'title',
    'url',
    'headRefOid',
    'baseRefName',
    'state',
    'isDraft',
    'mergeable',
    'mergeStateStatus',
    'reviewDecision',
  ].join(',');
  return parseJson<PullRequest>(
    runGh(['pr', 'view', ...targetArgs(prArg), '--json', fields]),
    'pull request',
  );
}

function fetchRepo(): RepoInfo {
  return parseJson<RepoInfo>(
    runGh(['repo', 'view', '--json', 'nameWithOwner']),
    'repository',
  );
}

function fetchChecks(prArg?: string): CheckRun[] {
  const fields = [
    'bucket',
    'completedAt',
    'description',
    'link',
    'name',
    'startedAt',
    'state',
    'workflow',
  ].join(',');
  const raw = runGh(
    ['pr', 'checks', ...targetArgs(prArg), '--json', fields],
    { allowExitCodes: [GH_PENDING_EXIT_CODE] },
  );
  return raw ? parseJson<CheckRun[]>(raw, 'checks') : [];
}

function fetchBranchProtection(repo: RepoInfo, branch: string): BranchProtection | undefined {
  const [owner, name] = repo.nameWithOwner.split('/');
  const endpoint = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches/${encodeURIComponent(branch)}/protection`;
  const result = runCommand(['gh', 'api', endpoint]);
  if (result.exitCode !== 0) {
    return undefined;
  }
  return parseJson<BranchProtection>(result.stdout, 'branch protection');
}

function fetchReviews(repo: RepoInfo, prNumber: number): Review[] {
  const raw = runGh([
    'api',
    `repos/${repo.nameWithOwner}/pulls/${prNumber}/reviews`,
    '--paginate',
  ]);
  return raw ? parseJson<Review[]>(raw, 'reviews') : [];
}

function fetchReviewComments(repo: RepoInfo, prNumber: number): ReviewComment[] {
  const raw = runGh([
    'api',
    `repos/${repo.nameWithOwner}/pulls/${prNumber}/comments`,
    '--paginate',
  ]);
  return raw ? parseJson<ReviewComment[]>(raw, 'review comments') : [];
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function formatBool(value: boolean | undefined): string {
  return value ? 'yes' : 'no';
}

function formatCheck(check: CheckRun): string {
  const workflow = check.workflow ? `${check.workflow} / ` : '';
  const suffix = check.state ? ` (${check.state})` : '';
  return `${workflow}${check.name}${suffix}`;
}

export function groupChecks(checks: CheckRun[]): Record<string, CheckRun[]> {
  return checks.reduce<Record<string, CheckRun[]>>((groups, check) => {
    const bucket = check.bucket || 'unknown';
    groups[bucket] ??= [];
    groups[bucket].push(check);
    return groups;
  }, {});
}

function markdownToText(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<details[\s\S]*?<\/details>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[`*_>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function withoutDetails(raw: string): string {
  return raw.replace(/<details[\s\S]*?<\/details>/gi, ' ');
}

function concise(text: string, maxLength = 140): string {
  const normalized = markdownToText(text);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function firstMarkdownBold(raw: string): string | undefined {
  const match = raw.match(/\*\*([^*\n][\s\S]*?)\*\*/);
  return match ? concise(match[1]) : undefined;
}

function firstUsefulLine(raw: string): string | undefined {
  for (const line of raw.split(/\r?\n/)) {
    const hint = concise(line);
    if (!hint) continue;
    if (/^(details|summary|blockquote|---)$/i.test(hint)) continue;
    if (/auto-generated|review info|run configuration|commits$/i.test(hint)) continue;
    if (/^(?:\W+\s*)?Potential issue\b/i.test(hint)) continue;
    return hint;
  }
  return undefined;
}

export function extractActionableHints(rawBody: string | null | undefined): string[] {
  if (!rawBody) return [];

  const hints: string[] = [];
  const actionable = rawBody.match(/\*\*Actionable comments posted:\s*([^*]+)\*\*/i);
  if (actionable) {
    hints.push(`Actionable comments posted: ${actionable[1].trim()}`);
  }

  const bulletPattern = /^\s*-\s+(?:Around\s+)?(?:Line\s+)?([^:]{0,80}):\s+(.+)$/gim;
  for (const match of rawBody.matchAll(bulletPattern)) {
    const location = concise(match[1], 64);
    const body = concise(match[2]);
    if (/^https?:\/\//i.test(body)) continue;
    if (body) hints.push(location ? `${location}: ${body}` : body);
  }

  const bodyWithoutDetails = withoutDetails(rawBody);
  const bold = firstMarkdownBold(bodyWithoutDetails);
  if (bold && !/^Actionable comments posted:/i.test(bold)) {
    hints.push(bold);
  }

  const usefulLine = firstUsefulLine(bodyWithoutDetails);
  if (usefulLine && !bold && !hints.includes(usefulLine)) {
    hints.push(usefulLine);
  }

  return Array.from(new Set(hints)).slice(0, 4);
}

function isBot(login: string | undefined): boolean {
  return Boolean(login && BOT_LOGIN_PATTERN.test(login));
}

function currentHeadReviews(reviews: Review[], headSha: string): Review[] {
  return reviews
    .filter(review => review.commit_id === headSha)
    .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
}

function botHints(reviews: Review[], comments: ReviewComment[], headSha: string): BotHint[] {
  const currentBotReviews = reviews.filter(review => review.commit_id === headSha && isBot(review.user?.login));
  const earliestCurrentBotReview = currentBotReviews
    .map(review => review.submitted_at ?? '')
    .filter(Boolean)
    .sort()[0];

  const reviewHints: BotHint[] = reviews
    .filter(review => review.commit_id === headSha && isBot(review.user?.login))
    .map(review => ({
      source: 'review',
      author: review.user?.login ?? 'unknown',
      when: review.submitted_at ?? '',
      hints: extractActionableHints(review.body),
    }))
    .filter(item => item.hints.length > 0);

  const commentHints: BotHint[] = comments
    .filter(comment => {
      if (comment.commit_id !== headSha || !isBot(comment.user?.login)) return false;
      if (comment.body?.includes('Addressed in commit')) return false;
      const when = comment.updated_at ?? comment.created_at ?? '';
      return !earliestCurrentBotReview || when >= earliestCurrentBotReview;
    })
    .map(comment => {
      const line = comment.line ?? comment.original_line ?? undefined;
      const location = comment.path ? `${comment.path}${line ? `:${line}` : ''}` : undefined;
      return {
        source: 'comment',
        author: comment.user?.login ?? 'unknown',
        when: comment.updated_at ?? comment.created_at ?? '',
        location,
        hints: extractActionableHints(comment.body),
      };
    })
    .filter(item => item.hints.length > 0);

  return [...reviewHints, ...commentHints]
    .sort((a, b) => b.when.localeCompare(a.when))
    .slice(0, 8);
}

function summarizeRequiredChecks(protection: BranchProtection | undefined): string {
  if (!protection) return 'unavailable';
  const contexts = protection.required_status_checks?.contexts ?? [];
  const checks = protection.required_status_checks?.checks
    ?.map(check => check.context)
    .filter((context): context is string => Boolean(context)) ?? [];
  const required = Array.from(new Set([...contexts, ...checks]));
  if (required.length === 0) return 'none';
  const strict = protection.required_status_checks?.strict ? 'strict' : 'not strict';
  return `${required.length} (${strict}): ${required.join(', ')}`;
}

export function summarizeProtection(protection: BranchProtection | undefined): string[] {
  if (!protection) return ['Branch protection: unavailable or not accessible'];
  const reviews = protection.required_pull_request_reviews;
  const approvalCount = reviews?.required_approving_review_count ?? 0;
  return [
    `Required checks: ${summarizeRequiredChecks(protection)}`,
    `Required reviews: ${approvalCount || 'none'}${approvalCount ? ` approval${approvalCount === 1 ? '' : 's'}` : ''}`,
    `Dismiss stale reviews: ${formatBool(reviews?.dismiss_stale_reviews)}`,
    `Code owner reviews: ${formatBool(reviews?.require_code_owner_reviews)}`,
    `Last-push approval: ${formatBool(reviews?.require_last_push_approval)}`,
    `Conversation resolution: ${formatBool(protection.required_conversation_resolution?.enabled)}`,
    `Signed commits: ${formatBool(protection.required_signatures?.enabled)}`,
    `Enforce admins: ${formatBool(protection.enforce_admins?.enabled)}`,
    `Allow force pushes: ${formatBool(protection.allow_force_pushes?.enabled)}`,
  ];
}

function printSection(title: string) {
  console.log(`\n${title}`);
}

function printList(items: string[], empty: string) {
  if (items.length === 0) {
    console.log(`  ${empty}`);
    return;
  }
  for (const item of items) {
    console.log(`  - ${item}`);
  }
}

function printChecks(checks: CheckRun[]) {
  const groups = groupChecks(checks);
  const order = ['fail', 'pending', 'pass', 'skipping', 'cancel'];
  for (const bucket of order) {
    const items = groups[bucket] ?? [];
    console.log(`  ${bucket}: ${items.length || 'none'}`);
    for (const check of items) {
      console.log(`    - ${formatCheck(check)}`);
    }
  }

  const known = new Set(order);
  for (const bucket of Object.keys(groups).filter(bucket => !known.has(bucket)).sort()) {
    console.log(`  ${bucket}: ${groups[bucket].length}`);
    for (const check of groups[bucket]) {
      console.log(`    - ${formatCheck(check)}`);
    }
  }
}

function usage() {
  console.log(`
PR Babysit Status

Usage:
  bun scripts/pr-babysit-status.ts [pr-number]

Without a PR number, gh resolves the PR for the current branch.
`);
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }

  const prArg = args[0];
  checkPrerequisites();

  const pr = fetchPr(prArg);
  const repo = fetchRepo();
  const [checks, protection, reviews, comments] = await Promise.all([
    Promise.resolve(fetchChecks(prArg)),
    Promise.resolve(fetchBranchProtection(repo, pr.baseRefName)),
    Promise.resolve(fetchReviews(repo, pr.number)),
    Promise.resolve(fetchReviewComments(repo, pr.number)),
  ]);

  const headReviews = currentHeadReviews(reviews, pr.headRefOid);
  const hints = botHints(reviews, comments, pr.headRefOid);

  console.log(`PR #${pr.number}: ${pr.title}`);
  console.log(`URL: ${pr.url}`);
  console.log(`Head: ${shortSha(pr.headRefOid)} (${pr.headRefOid})`);
  console.log(`Base: ${pr.baseRefName}`);
  console.log(`State: ${pr.state}; draft=${formatBool(pr.isDraft)}; mergeable=${pr.mergeable}; mergeStateStatus=${pr.mergeStateStatus}; reviewDecision=${pr.reviewDecision}`);

  printSection(`Checks (${checks.length} current-head)`);
  printChecks(checks);

  printSection(`Branch Protection (${pr.baseRefName})`);
  for (const line of summarizeProtection(protection)) {
    console.log(`  ${line}`);
  }

  printSection('Current-Head Reviews');
  printList(
    headReviews.map(review => {
      const author = review.user?.login ?? 'unknown';
      const summary = concise(review.body ?? '', 80);
      const suffix = summary ? ` - ${summary}` : '';
      return `${review.submitted_at ?? 'unknown time'} ${author}: ${review.state}${suffix}`;
    }),
    'none',
  );

  printSection('Actionable Bot Hints');
  if (hints.length === 0) {
    console.log('  none');
  } else {
    for (const hint of hints) {
      const location = hint.location ? ` ${hint.location}` : '';
      console.log(`  - ${hint.when} ${hint.author} ${hint.source}${location}`);
      for (const item of hint.hints) {
        console.log(`    ${item}`);
      }
    }
  }
}

function isDirectRun(): boolean {
  if (process.env.PR_BABYSIT_STATUS_NO_MAIN === '1') {
    return false;
  }
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  });
}
