// Work product: the things a request produced that a person can open — a
// published artifact or page, a pull request, a deck, an image, a report.
// Every entry comes from a recorded source (a captured tool call, an observer's
// files_modified list, or a work-state field) and keeps a reference to it.
import { statSync } from 'node:fs';
import { basename, extname } from 'node:path';

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

function isLocalPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0') && !value.split('/').includes('..');
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

/** Work product recorded by one captured tool call. */
export function productsFromToolUse(call) {
  const input = parse(call.tool_input) ?? {}, response = parse(call.tool_response);
  const sourceRef = { kind: 'tool-use', id: call.id };
  const atEpoch = call.created_at_epoch ?? null;
  if (call.tool_name === 'Bash' && typeof input.command === 'string') {
    // The command must run `gh pr create` itself. A command that only mentions
    // it (a search, a quoted string) made nothing — Claude Code's recorded
    // gitOperation.pr can name a PR merely printed by such a command.
    if (!/(?:^|[;&|(\n])\s*(?:rtk\s+)?gh\s+pr\s+create\b/.test(input.command)) return [];
    const printed = String(response?.stdout ?? (typeof call.tool_response === 'string' ? call.tool_response : '')).match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/m)?.[0];
    const url = safeWebUrl(response?.gitOperation?.pr?.url ?? printed);
    if (!url) return [];
    const title = input.command.match(/--title\s+(?:"([^"]+)"|'([^']+)')/);
    return [{ kind: 'pull-request', title: short(title?.[1] ?? title?.[2]) ?? `PR #${url.split('/').at(-1)}`, url, atEpoch, sourceRef }];
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
    const values = WORK_PRODUCT_FIELDS.has(field) ? (Array.isArray(value) ? value : [value]) : typeof value === 'string' ? [value] : [];
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

/** Newest first, one entry per link or file. */
export function mergeProducts(lists, limit = 60) {
  const unique = new Map();
  for (const product of lists.flat().sort((a, b) => (b.atEpoch ?? 0) - (a.atEpoch ?? 0))) {
    const key = product.url ?? product.path;
    if (!unique.has(key)) unique.set(key, product);
  }
  return [...unique.values()].slice(0, limit);
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

/** Recorded calls and observations that may hold work product since `sinceEpoch`. */
export function readProductRecords(read, sinceEpoch, limit = 2000) {
  const productCalls = read(`SELECT id, session_db_id, prompt_number, tool_name, tool_input, tool_response, created_at_epoch FROM tool_uses
    WHERE created_at_epoch >= ? AND (tool_name IN ('Artifact', 'mcp__claude_ai_Notion__notion-create-pages', 'mcp__claude_ai_Claude_Docs__batch', 'mcp__claude_ai_Claude_Docs__create')
      OR tool_name LIKE '%chatgpt_space__create_page' OR tool_name LIKE '%sites__save_version_and_deploy%'
      OR (tool_name = 'Bash' AND tool_input LIKE '%gh pr create%'))
    ORDER BY id DESC LIMIT ?`, [sinceEpoch, limit]);
  const productObservations = read(`SELECT id, memory_session_id, prompt_number, files_modified, created_at_epoch FROM observations
    WHERE created_at_epoch >= ? AND (${FILE_EXTENSION_PATTERN}) ORDER BY id DESC LIMIT ?`, [sinceEpoch, limit]);
  return { productCalls, productObservations };
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
