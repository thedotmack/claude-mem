// Work product: the things a request produced that a person can open — a
// published artifact or page, a pull request, a deck, an image, a report.
// Every entry comes from a recorded source (a captured tool call, an observer's
// files_modified list, or a work-state field) and keeps a reference to it.
import { statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';

// Files a person opens, not source code. Anything else stays in the work history.
const FILE_KINDS = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.svg': 'image',
  '.mp4': 'video', '.mov': 'video', '.webm': 'video',
  '.pdf': 'document', '.docx': 'document',
  '.pptx': 'deck', '.key': 'deck',
  '.xlsx': 'spreadsheet', '.csv': 'spreadsheet',
  '.html': 'page',
};
export const FILE_CONTENT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.key': 'application/octet-stream',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv; charset=utf-8',
};

// Tools whose recorded result is a published link to the thing they made.
const PUBLISHING_TOOLS = [
  { match: /^Artifact$/, kind: 'artifact' },
  { match: /notion-create-pages$/, kind: 'page' },
  { match: /Claude_Docs__(?:batch|create)$/, kind: 'document' },
  { match: /chatgpt_space__create_page$/, kind: 'page' },
  { match: /sites__save_version_and_deploy/, kind: 'deployment' },
];
// Work-state fields that name work product directly. `work_product` is the
// field agents use to attach anything; *_url fields are read as links.
const WORK_PRODUCT_FIELDS = new Set(['work_product', 'work_products', 'deliverable', 'deliverables']);
const LEGACY_KINDS = { docs_url: 'documentation', documentation_url: 'documentation', promo_url: 'promotion', announcement_url: 'promotion', pr_url: 'pull-request', deck_url: 'deck', artifact_url: 'artifact' };

const MAX_TITLE = 140;
const short = (value) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text ? text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1).trimEnd()}…` : text : null;
};

export function safeWebUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** An absolute path on this platform (`/…`, or `C:\…` / `C:/…` / `\\server\…` on Windows) with no `..` part. */
export function isLocalPath(value, isAbsolutePath = isAbsolute) {
  return typeof value === 'string' && isAbsolutePath(value) && !value.includes('\0') && !value.split(/[\\/]/).includes('..');
}

/** The kind of a local file a person would open, or null for code and data. */
export function fileKind(path) {
  return isLocalPath(path) ? FILE_KINDS[extname(path).toLowerCase()] ?? null : null;
}

function kindForUrl(url, fallback) {
  const { hostname, pathname } = new URL(url);
  if (hostname === 'github.com' && /\/pull\/\d+/.test(pathname)) return 'pull-request';
  if (/\.(?:vercel\.app|netlify\.app|pages\.dev)$/.test(hostname)) return 'deployment';
  const extension = FILE_KINDS[extname(pathname).toLowerCase()];
  return extension ?? fallback;
}

function parse(value) {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return null; }
}

function urlsIn(value, found = []) {
  if (typeof value === 'string') { const url = safeWebUrl(value); if (url) found.push(url); }
  else if (Array.isArray(value)) for (const item of value) urlsIn(item, found);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) if (/url$/i.test(key) || typeof item === 'object') urlsIn(item, found);
  return found;
}

// A command runs a git subcommand itself only at the start of a shell
// statement (`git`, `rtk git`, `/usr/bin/git`, with any -C/-c options). A
// command that only mentions it (a search, a quoted string) made nothing.
const GIT_PREFIX = String.raw`(?:^|[;&|(\n])\s*(?:rtk\s+)?(?:\/usr\/bin\/)?git(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))*\s+`;
const gitPattern = (subcommand, flags = '') => new RegExp(GIT_PREFIX + subcommand, flags);
const GITHUB_REMOTE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const SHA = '[0-9a-f]{7,40}';
const unquote = (token) => token.replace(/^(["'])(.*)\1$/, '$2');

/** The GitHub `owner/repo` a remote URL names, or null for any other host. */
export function githubRepo(remote) {
  const match = typeof remote === 'string' ? remote.trim().match(GITHUB_REMOTE) : null;
  return match ? `${match[1]}/${match[2]}` : null;
}

function gitUrl(product) {
  if (!product.repo) return undefined;
  return product.kind === 'commit' ? `https://github.com/${product.repo}/commit/${product.sha}` : `https://github.com/${product.repo}/tree/${product.branch}`;
}

function outputText(call, response) {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') return [response.stdout, response.stderr].filter((part) => typeof part === 'string').join('\n');
  return typeof call.tool_response === 'string' ? call.tool_response : '';
}

// The subject line of the message each `git commit` in a command passes with
// -m or a heredoc, in order; null where the message comes from elsewhere.
function commitSubjects(command) {
  const starts = [...command.matchAll(gitPattern(String.raw`commit\b`, 'g'))].map((match) => match.index);
  return starts.map((start, index) => {
    const invocation = command.slice(start, starts[index + 1]);
    const inline = invocation.match(/\s-[a-zA-Z]*m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/);
    const heredoc = invocation.match(/\s-F\s+-\s*<<-?\s*['"]?\w+['"]?\n([^\n]*)/);
    const text = inline ? (inline[1] ?? inline[2]).replace(/\\(.)/g, '$1') : heredoc?.[1];
    return short(text?.split('\n')[0]);
  });
}

/** Commits a recorded command made, from git's `[<branch> <sha>] <subject>` line,
 * Claude Code's gitOperation, or (for quiet commits) the commit's own subject
 * printed back by a following `git log --oneline`. */
function commitsFrom(command, response, out) {
  const commits = new Map();
  const add = (sha, branch, subject) => {
    const key = sha.slice(0, 7);
    const known = commits.get(key);
    commits.set(key, { sha: known?.sha.length > sha.length ? known.sha : sha, branch: branch ?? known?.branch ?? null, subject: subject ?? known?.subject ?? null });
  };
  const recorded = response?.gitOperation?.commit;
  const subjects = commitSubjects(command);
  if (!subjects.length && !recorded?.sha) return [];
  for (const [, ref, sha, subject] of out.matchAll(new RegExp(String.raw`^\[(.+?)(?: \(root-commit\))? (${SHA})\] (.+)$`, 'gm'))) {
    add(sha, ref.startsWith('detached HEAD') ? null : ref, short(subject));
  }
  if (typeof recorded?.sha === 'string' && new RegExp(`^${SHA}$`).test(recorded.sha)) add(recorded.sha, typeof recorded.branch === 'string' ? recorded.branch : null, null);
  if (!commits.size) {
    // Quiet commits (-q) print nothing; rtk prints `ok <sha>` for a single one.
    const rtkSha = subjects.length === 1 ? out.match(new RegExp(`^ok (${SHA})$`, 'm'))?.[1] : null;
    if (rtkSha) add(rtkSha, null, subjects[0]);
    else {
      const printed = [...out.matchAll(new RegExp(`^(${SHA}) (.+)$`, 'gm'))].map(([, sha, subject]) => [sha, short(subject)]);
      for (const subject of subjects) {
        const match = subject && printed.find(([, printedSubject]) => printedSubject === subject);
        if (match) add(match[0], null, subject);
      }
    }
  }
  return [...commits.values()];
}

// The remote and branch a `git push` command names (`git push -u origin <branch>`,
// `git push <url> HEAD:<branch>`); null for a push that deletes or sends tags.
function pushTarget(command) {
  const args = command.match(gitPattern(String.raw`push((?:[ \t]+(?:"[^"]*"|'[^']*'|[^\s;&|)]+))*)`))?.[1];
  const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean).map(unquote);
  if (tokens.some((token) => ['-d', '--delete', '--tags', '--mirror', '--all'].includes(token))) return null;
  const [remote, refspec] = tokens.filter((token) => !token.startsWith('-'));
  const branch = refspec && !refspec.startsWith(':') ? refspec.replace(/^\+/, '').split(':').at(-1).replace(/^refs\/heads\//, '') : null;
  return { repo: githubRepo(remote), branch: branch && branch !== 'HEAD' ? branch : null };
}

/** Branches a recorded `git push` updated, each with the GitHub repo it went to
 * (from git's `To <remote>` line or the remote URL in the command) and the
 * commit the push left it at. */
function pushesFrom(command, response, out) {
  const runs = gitPattern(String.raw`push\b`).test(command);
  const recorded = typeof response?.gitOperation?.push?.branch === 'string' ? response.gitOperation.push.branch : null;
  if (!runs && !recorded) return [];
  const target = runs ? pushTarget(command) : null;
  const pushes = new Map();
  let repo = null;
  for (const line of out.split('\n')) {
    const remote = line.match(/^To (\S+)$/);
    if (remote) { repo = githubRepo(remote[1]); continue; }
    const ref = line.match(new RegExp(String.raw`^\s*[ +*=]?\s*(?:${SHA}\.\.\.?(${SHA})|\[new branch\])\s+(\S+)\s+->\s+(\S+)`));
    if (!ref) continue;
    const branch = ref[3].replace(/^refs\/heads\//, '');
    pushes.set(branch, { branch, repo: repo ?? target?.repo ?? null, heads: ref[1] ? [ref[1]] : [] });
  }
  // A quiet push prints no ref line: use the branch gitOperation or the command names.
  const branch = recorded ?? target?.branch;
  if (!pushes.size && branch && !/\[rejected\]|failed to push|^fatal:/m.test(out)) pushes.set(branch, { branch, repo: target?.repo ?? null, heads: [] });
  return [...pushes.values()];
}

/** Branches a recorded `git checkout -b` / `git switch -c` created. */
function createdBranchesFrom(command, out) {
  if (/^fatal:/m.test(out)) return [];
  return [...command.matchAll(gitPattern(String.raw`(?:checkout\s+-[bB]|switch\s+-[cC])\s+("[^"]+"|'[^']+'|[^\s;&|)]+)`, 'g'))].map((match) => ({ branch: unquote(match[1]), repo: null, heads: [] }));
}

function pullRequestFrom(command, response, out, { atEpoch, sourceRef }) {
  // The command must run `gh pr create` itself. A command that only mentions
  // it (a search, a quoted string) made nothing — Claude Code's recorded
  // gitOperation.pr can name a PR merely printed by such a command.
  if (!/(?:^|[;&|(\n])\s*(?:rtk\s+)?gh\s+pr\s+create\b/.test(command)) return [];
  const printed = out.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/m)?.[0];
  const url = safeWebUrl(response?.gitOperation?.pr?.url ?? printed);
  if (!url) return [];
  const title = command.match(/--title\s+(?:"([^"]+)"|'([^']+)')/);
  return [{ kind: 'pull-request', title: short(title?.[1] ?? title?.[2]) ?? `PR #${url.split('/').at(-1)}`, url, atEpoch, sourceRef }];
}

/** Commits and branches one recorded Bash command made. */
export function gitProductsFromCommand(command, response, out, { atEpoch = null, sourceRef = null } = {}) {
  const pushes = pushesFrom(command, response, out);
  const branches = new Map([...createdBranchesFrom(command, out), ...pushes].map((branch) => [branch.branch, branch]));
  const products = [];
  for (const commit of commitsFrom(command, response, out)) {
    const pushed = (commit.branch && pushes.find((push) => push.branch === commit.branch)) || pushes.find((push) => push.heads.some((head) => head.startsWith(commit.sha.slice(0, 7))))
      // A quiet commit pushed by the same command went to the one branch it pushed.
      || (!commit.branch && pushes.length === 1 ? pushes[0] : null);
    products.push({ kind: 'commit', title: commit.subject ? `${commit.sha.slice(0, 7)} ${commit.subject}` : commit.sha.slice(0, 7), sha: commit.sha, branch: commit.branch ?? pushed?.branch ?? null, repo: pushed?.repo ?? null, atEpoch, sourceRef });
  }
  for (const branch of branches.values()) products.push({ kind: 'branch', title: branch.branch, branch: branch.branch, repo: branch.repo, heads: branch.heads, atEpoch, sourceRef });
  return products.map((product) => ({ ...product, url: gitUrl(product) }));
}

/** Work product recorded by one captured tool call. */
export function productsFromToolUse(call) {
  const input = parse(call.tool_input) ?? {}, response = parse(call.tool_response);
  const sourceRef = { kind: 'tool-use', id: call.id };
  const atEpoch = call.created_at_epoch ?? null;
  if (call.tool_name === 'Bash' && typeof input.command === 'string') {
    const out = outputText(call, response);
    return [...pullRequestFrom(input.command, response, out, { atEpoch, sourceRef }), ...gitProductsFromCommand(input.command, response, out, { atEpoch, sourceRef })];
  }
  const publisher = PUBLISHING_TOOLS.find((tool) => tool.match.test(call.tool_name));
  if (!publisher || !response) return [];
  // An Artifact call that lists, reads or describes types publishes nothing.
  if (call.tool_name === 'Artifact' && (input.action ?? 'publish') !== 'publish') return [];
  if (call.tool_name === 'Artifact' && input.asset) return [];
  const urls = [...new Set(urlsIn(response))].filter((url) => !/\/(?:api|oauth)\//.test(new URL(url).pathname));
  const title = short(response.title ?? input.title ?? input.name) ?? (isLocalPath(input.file_path) ? basename(input.file_path) : null);
  return urls.slice(0, 1).map((url) => ({ kind: kindForUrl(url, publisher.kind), title: title ?? new URL(url).hostname, url, atEpoch, sourceRef }));
}

/** Human-facing files an observer recorded as modified. */
export function productsFromObservation(observation) {
  const files = parse(observation.files_modified);
  if (!Array.isArray(files)) return [];
  return files.flatMap((path, index) => {
    const kind = fileKind(path);
    // A generic entry file is named by its folder (…/launch-review/index.html).
    const title = /^index\.\w+$/i.test(basename(path)) ? basename(path.slice(0, -basename(path).length - 1)) || basename(path) : basename(path);
    return kind ? [{ kind, title, path, atEpoch: observation.created_at_epoch ?? null, sourceRef: { kind: 'observation', id: observation.id, index } }] : [];
  });
}

export function isWorkProductField(field) {
  return WORK_PRODUCT_FIELDS.has(field) || /_url$/.test(field);
}

/** Work product attached through one work-state entry's fields. `index`
 * counts across the whole entry so the file route can find it again. */
export function productsFromFields(fields, { atEpoch = null, sourceRef = null } = {}) {
  const products = [];
  let index = 0;
  for (const [field, value] of Object.entries(fields ?? {})) {
    if (!isWorkProductField(field)) continue;
    // Work-state fields are plain values, so several products (with titles) arrive as one JSON string.
    const decoded = WORK_PRODUCT_FIELDS.has(field) && typeof value === 'string' && /^\s*[[{]/.test(value) ? parse(value) ?? value : value;
    const values = WORK_PRODUCT_FIELDS.has(field) ? (Array.isArray(decoded) ? decoded : [decoded]) : typeof value === 'string' ? [value] : [];
    for (const value of values) {
      const entry = value && typeof value === 'object' && !Array.isArray(value) ? value : { url: value };
      const url = safeWebUrl(entry.url ?? entry.link);
      const path = isLocalPath(entry.path) ? entry.path : isLocalPath(entry.url) ? entry.url : null;
      const kind = short(entry.kind), title = short(entry.title ?? entry.name);
      const ref = sourceRef && { ...sourceRef, index: index++ };
      if (url) products.push({ kind: kind ?? kindForUrl(url, LEGACY_KINDS[field] ?? 'link'), title: title ?? new URL(url).hostname, url, field, atEpoch, sourceRef: ref });
      else if (path && (kind || fileKind(path))) products.push({ kind: kind ?? fileKind(path), title: title ?? basename(path), path, field, atEpoch, sourceRef: ref });
    }
  }
  return products;
}

// A commit is one entry per sha, a branch one per name, anything else one per link or file.
const productKey = (product) => product.kind === 'commit' && product.sha ? `commit:${product.sha.slice(0, 7)}`
  : product.kind === 'branch' && product.branch ? `branch:${product.branch}` : product.url ?? product.path;

/** Newest first, one entry per commit, branch, link or file. A commit or
 * branch links to GitHub when a push in the same lists sent it there: its
 * branch was pushed at or after it was made, the push left the branch at that
 * commit, or another commit made by the same command was. */
export function mergeProducts(lists, limit = 60) {
  const products = lists.flat();
  const pushesByBranch = new Map(), repoByHead = new Map(), repoBySource = new Map();
  for (const product of products) if (product.kind === 'branch' && product.repo) {
    if (!pushesByBranch.has(product.branch)) pushesByBranch.set(product.branch, []);
    pushesByBranch.get(product.branch).push(product);
    for (const head of product.heads ?? []) repoByHead.set(head.slice(0, 7), product.repo);
  }
  const sourceKey = (product) => product.sourceRef ? `${product.sourceRef.kind}:${product.sourceRef.id}` : null;
  const pushedAfter = (product) => pushesByBranch.get(product.branch)?.find((push) => product.kind === 'branch' || (push.atEpoch ?? 0) >= (product.atEpoch ?? 0))?.repo;
  const repoOf = (product) => product.repo ?? pushedAfter(product) ?? (product.sha ? repoByHead.get(product.sha.slice(0, 7)) : undefined) ?? null;
  for (const product of products) if (product.kind === 'commit' && repoOf(product) && sourceKey(product)) repoBySource.set(sourceKey(product), repoOf(product));
  const unique = new Map();
  for (const product of products.sort((a, b) => (b.atEpoch ?? 0) - (a.atEpoch ?? 0))) {
    const key = productKey(product);
    if (unique.has(key)) continue;
    const isGit = product.kind === 'commit' || product.kind === 'branch';
    const repo = isGit && !product.repo ? repoOf(product) ?? (product.kind === 'commit' ? repoBySource.get(sourceKey(product)) : null) : null;
    unique.set(key, repo ? { ...product, repo, url: gitUrl({ ...product, repo }) } : product);
  }
  return [...unique.values()].slice(0, limit);
}

/**
 * A bucket copy the Stop hook made (the worker's `deliverables` table). It
 * opens through the deliverables route for as long as the copy exists, and
 * it supersedes the work-state or observation record of the file it was
 * copied from (`sourcePath`), which stops opening once that file is deleted.
 */
export function productsFromDeliverable(row) {
  if (!Number.isSafeInteger(row?.id) || row.id < 1 || typeof row.bucket_path !== 'string' || !row.bucket_path) return [];
  const name = basename(row.bucket_path);
  return [{
    kind: short(row.kind) ?? fileKind(row.bucket_path) ?? 'file',
    title: short(row.title) ?? name,
    url: `/api/deliverables/${row.id}/${encodeURIComponent(name)}`,
    bucketPath: row.bucket_path,
    sourcePath: typeof row.source_path === 'string' ? row.source_path : null,
    deliverable: true,
    atEpoch: row.created_at_epoch ?? null,
    sourceRef: { kind: 'deliverable', id: row.id },
  }];
}

/** A bucket copy is available while it still exists as a regular file. */
export function bucketFileAvailable(product) {
  if (typeof product?.bucketPath !== 'string' || !product.bucketPath) return false;
  try { return statSync(product.bucketPath).isFile(); }
  catch { return false; }
}
// True when a bucket copy stands in for the record of the file it was copied
// from: the copy is on disk, and the source is gone or has not been written
// since the copy was made. A copy that is missing, or older than the source's
// last write, leaves the source record in place beside it.
export function copyCoversSource(copy, sourcePath) {
  if (typeof copy?.atEpoch !== 'number' || !bucketFileAvailable(copy)) return false;
  try {
    const source = statSync(sourcePath);
    return !source.isFile() || source.mtimeMs <= copy.atEpoch;
  } catch { return true; }
}

/** A local file is served only while it still exists as a regular file. */
export function servableFile(product) {
  if (!product?.path || !fileKind(product.path)) return null;
  try { return statSync(product.path).isFile() ? product.path : null; }
  catch { return null; }
}

// The viewer opens a local file only through the record that names it, so a
// client never supplies a path.
export function fileUrl(product) {
  const ref = product.sourceRef;
  return product.path && ref ? `/api/work-view/file/${ref.kind}/${ref.id}/${ref.index ?? 0}` : null;
}

const FILE_EXTENSION_PATTERN = Object.keys(FILE_KINDS).map((extension) => `files_modified LIKE '%${extension}"%'`).join(' OR ');

/** Recorded calls and observations that may hold work product since `sinceEpoch`.
 * Git commands are read separately so their volume never crowds out publishers. */
export function readProductRecords(read, sinceEpoch, limit = 2000) {
  const publishingCalls = read(`SELECT id, session_db_id, prompt_number, tool_name, tool_input, tool_response, created_at_epoch FROM tool_uses
    WHERE created_at_epoch >= ? AND (tool_name IN ('Artifact', 'mcp__claude_ai_Notion__notion-create-pages', 'mcp__claude_ai_Claude_Docs__batch', 'mcp__claude_ai_Claude_Docs__create')
      OR tool_name LIKE '%chatgpt_space__create_page' OR tool_name LIKE '%sites__save_version_and_deploy%'
      OR (tool_name = 'Bash' AND tool_input LIKE '%gh pr create%'))
    ORDER BY id DESC LIMIT ?`, [sinceEpoch, limit]);
  const gitCalls = read(`SELECT id, session_db_id, prompt_number, tool_name, tool_input, tool_response, created_at_epoch FROM tool_uses
    WHERE created_at_epoch >= ? AND tool_name = 'Bash' AND tool_input LIKE '%git%' AND tool_input NOT LIKE '%gh pr create%'
      AND (tool_input LIKE '%commit%' OR tool_input LIKE '%push%' OR tool_input LIKE '%checkout -b%' OR tool_input LIKE '%switch -c%')
    ORDER BY id DESC LIMIT ?`, [sinceEpoch, limit]);
  const productCalls = [...publishingCalls, ...gitCalls];
  const productObservations = read(`SELECT id, memory_session_id, prompt_number, files_modified, created_at_epoch FROM observations
    WHERE created_at_epoch >= ? AND (${FILE_EXTENSION_PATTERN}) ORDER BY id DESC LIMIT ?`, [sinceEpoch, limit]);
  // Bucket copies the Stop hook made; a database from before the table existed has none (safeRead answers []).
  const productDeliverables = read(`SELECT id, project, content_session_id, platform_source, title, kind, source_path, bucket_path, created_at_epoch
    FROM deliverables WHERE created_at_epoch >= ? ORDER BY id DESC LIMIT ?`, [sinceEpoch, limit]);
  return { productCalls, productObservations, productDeliverables };
}

/** The local file one record names at `index`, re-read from that record. */
export function recordedFile(read, kind, id, index) {
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(index) || index < 0) return null;
  let products = [];
  if (kind === 'observation') {
    const row = read('SELECT id, files_modified, created_at_epoch FROM observations WHERE id = ?', [id])[0];
    products = row ? productsFromObservation(row) : [];
  } else if (kind === 'work-state') {
    const row = read('SELECT id, fields FROM work_state_entries WHERE id = ?', [id])[0];
    products = row ? productsFromFields(parse(row.fields), { sourceRef: { kind, id } }) : [];
  }
  return servableFile(products.find((product) => product.sourceRef?.index === index)) ?? null;
}
