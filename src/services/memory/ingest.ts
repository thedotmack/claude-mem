/**
 * Claude Code auto-memory ingest (sibling to the transcript backfill #2690).
 *
 * Claude Code writes "auto memory" — markdown it distills for itself — to
 *   ~/.claude/projects/<encoded-cwd>/memory/MEMORY.md   (an index of links)
 *   ~/.claude/projects/<encoded-cwd>/memory/<topic>.md  (distilled prose)
 * where <encoded-cwd> is the repo's absolute path with '/' replaced by '-'.
 *
 * Unlike transcripts, memory is ALREADY distilled — each topic file is the same
 * KIND of artifact the observation generator produces. So memory-ingest does NOT
 * run the Haiku generation pipeline. It stores each file's prose DIRECTLY as an
 * observation (mechanical store-direct), reusing claude-mem's existing
 * `storeObservation` seam (content-hash dedup + Chroma sync). Re-running Haiku on
 * already-distilled prose would be lossy and pay for negative value.
 *
 * This module is the spend-free, DB-free half: enumerate + parse + count. The
 * real store path (ingest.ts `ingestMemorySource`, added alongside) runs inside
 * the worker where the SQLite store lives.
 */
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { basename, dirname, join } from 'path';
import { homedir } from 'os';
import { getProjectContext } from '../../utils/project-name.js';

const MD_EXT = '.md';
const JSONL_EXT = '.jsonl';
/** The link-only index Claude Code maintains; carries no knowledge of its own. */
const INDEX_FILE = 'MEMORY.md';
const MEMORY_SUBDIR = 'memory';
/** Bytes of a sibling transcript to sniff for the project's real cwd. */
const CWD_SNIFF_BYTES = 16_384;

/** Default root that holds every `<encoded-cwd>/memory/` directory. */
export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Minimal `~` expansion — kept local so this module is PR-independent of #2690. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

// ───────────────────────────── frontmatter ──────────────────────────────
//
// Topic files carry a small YAML frontmatter block, e.g.
//   ---
//   name: recent-work
//   description: "What was done in the most recent session"
//   metadata:
//     node_type: memory
//     type: project
//     originSessionId: 74e59070-...
//   ---
// We hand-roll a parser for exactly this shape rather than add a YAML dep.

export interface MemoryFrontmatter {
  name?: string;
  description?: string;
  /** metadata.type — e.g. project | feedback | reference | user. */
  type?: string;
  /** metadata.originSessionId — the session that produced this memory. */
  originSessionId?: string;
  /** metadata.node_type — e.g. "memory". */
  nodeType?: string;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Split leading `--- ... ---` frontmatter from the body. Returns parsed (known)
 * keys and the remaining markdown body. Files without frontmatter return `{}`
 * and the original text as body.
 */
export function parseMemoryFrontmatter(raw: string): { frontmatter: MemoryFrontmatter; body: string } {
  if (!raw.startsWith('---')) return { frontmatter: {}, body: raw };

  const lines = raw.split('\n');
  // First line is the opening '---'; find the closing one.
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { close = i; break; }
  }
  if (close === -1) return { frontmatter: {}, body: raw };

  const fm: MemoryFrontmatter = {};
  let inMetadata = false;
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indented = /^\s+/.test(line);
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    if (!indented) {
      inMetadata = key === 'metadata';
      if (key === 'name') fm.name = unquote(value);
      else if (key === 'description') fm.description = unquote(value);
      continue;
    }
    // Indented: a child of `metadata:`.
    if (inMetadata) {
      if (key === 'type') fm.type = unquote(value);
      else if (key === 'originSessionId') fm.originSessionId = unquote(value);
      else if (key === 'node_type') fm.nodeType = unquote(value);
    }
  }

  const body = lines.slice(close + 1).join('\n').replace(/^\n+/, '');
  return { frontmatter: fm, body };
}

/** Derive a human title: frontmatter name → first H1 → first H2 → filename stem. */
export function deriveTitle(fileName: string, frontmatter: MemoryFrontmatter, body: string): string {
  if (frontmatter.name && frontmatter.name.trim()) return frontmatter.name.trim();
  for (const line of body.split('\n')) {
    const h1 = line.match(/^#\s+(.+)/);
    if (h1) return h1[1].trim();
  }
  for (const line of body.split('\n')) {
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) return h2[1].trim();
  }
  return basename(fileName, MD_EXT);
}

// ───────────────────────────── enumeration ──────────────────────────────

export interface MemoryFileRef {
  filePath: string;
  fileName: string;
  /** True for the MEMORY.md link index — excluded from ingest. */
  isIndex: boolean;
  bytes: number;
  /** File mtime in epoch ms — used to backdate the stored observation. */
  mtimeEpoch: number;
  title: string;
  frontmatter: MemoryFrontmatter;
  /** Markdown body with the frontmatter block stripped — the stored narrative. */
  body: string;
}

export interface MemoryDirRef {
  memoryDir: string;
  /** The `<encoded-cwd>` directory name (parent of memory/). */
  encodedName: string;
  /** Resolved absolute repo cwd (from a sibling transcript), if found. */
  cwd?: string;
  /** Project key — MUST match live capture's getProjectContext so recall merges. */
  project: string;
  /** Non-index topic files (the ingestable knowledge). */
  files: MemoryFileRef[];
  /** The MEMORY.md index, recorded for reporting but never ingested. */
  indexFile?: MemoryFileRef;
}

export interface ScanOptions {
  /** Treat `source` as the projects root and sweep every `<encoded>/memory/`. */
  all?: boolean;
}

/** Read the first JSONL line that carries a `cwd` from a sibling transcript. */
function sniffCwd(projectDir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(projectDir).filter(n => n.endsWith(JSONL_EXT));
  } catch {
    return undefined;
  }
  for (const name of names) {
    const filePath = join(projectDir, name);
    let fd: number | undefined;
    try {
      fd = openSync(filePath, 'r');
      const buf = Buffer.alloc(CWD_SNIFF_BYTES);
      const read = readSync(fd, buf, 0, CWD_SNIFF_BYTES, 0);
      const chunk = buf.toString('utf-8', 0, read);
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const cwd = (JSON.parse(trimmed) as { cwd?: unknown }).cwd;
          if (typeof cwd === 'string' && cwd.trim()) return cwd;
        } catch {
          // Partial last line from the fixed-size read, or a non-JSON line.
        }
      }
    } catch {
      // Unreadable transcript — try the next sibling.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return undefined;
}

/** Best-effort project key when no sibling transcript reveals the cwd. */
function fallbackProject(cwd: string | undefined, encodedName: string): string {
  if (cwd) {
    try {
      const primary = getProjectContext(cwd).primary;
      if (primary && primary.trim()) return primary;
    } catch {
      // getProjectContext may probe git; fall through to the basename.
    }
    const segs = cwd.split('/').filter(Boolean);
    if (segs.length) return segs[segs.length - 1];
  }
  // Last resort: the trailing segment of the encoded dir name.
  const segs = encodedName.replace(/^-+/, '').split('-').filter(Boolean);
  return segs.length ? segs[segs.length - 1] : encodedName;
}

function readMemoryDir(memoryDir: string): MemoryDirRef {
  const projectDir = dirname(memoryDir);
  const encodedName = basename(projectDir);
  const cwd = sniffCwd(projectDir);
  const project = fallbackProject(cwd, encodedName);

  const ref: MemoryDirRef = { memoryDir, encodedName, cwd, project, files: [] };

  for (const name of readdirSync(memoryDir)) {
    if (!name.endsWith(MD_EXT)) continue;
    const filePath = join(memoryDir, name);
    const stat = statSync(filePath);
    if (!stat.isFile()) continue;

    const raw = readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseMemoryFrontmatter(raw);
    const isIndex = name === INDEX_FILE;
    const fileRef: MemoryFileRef = {
      filePath,
      fileName: name,
      isIndex,
      bytes: stat.size,
      mtimeEpoch: Math.round(stat.mtimeMs),
      title: deriveTitle(name, frontmatter, body),
      frontmatter,
      body,
    };
    if (isIndex) ref.indexFile = fileRef;
    else ref.files.push(fileRef);
  }

  ref.files.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return ref;
}

function hasMemorySubdir(dir: string): boolean {
  const sub = join(dir, MEMORY_SUBDIR);
  return existsSync(sub) && statSync(sub).isDirectory();
}

/**
 * Enumerate memory directories under `source`.
 *
 * `source` may be:
 *   - a `memory/` directory itself,
 *   - a `<encoded-cwd>` project directory that contains a `memory/` subdir,
 *   - (with `all: true`) the projects root, swept for every `<encoded>/memory/`.
 */
export function scanMemorySource(source: string, options: ScanOptions = {}): MemoryDirRef[] {
  const resolved = expandHome(source);
  if (!existsSync(resolved)) {
    throw new Error(`memory ingest source not found: ${resolved}`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`memory ingest source is not a directory: ${resolved}`);
  }

  if (options.all) {
    const refs: MemoryDirRef[] = [];
    for (const name of readdirSync(resolved)) {
      const projectDir = join(resolved, name);
      try {
        if (!statSync(projectDir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (hasMemorySubdir(projectDir)) {
        refs.push(readMemoryDir(join(projectDir, MEMORY_SUBDIR)));
      }
    }
    refs.sort((a, b) => a.encodedName.localeCompare(b.encodedName));
    return refs;
  }

  // Single target: accept either the memory/ dir or its parent project dir.
  if (basename(resolved) === MEMORY_SUBDIR) {
    return [readMemoryDir(resolved)];
  }
  if (hasMemorySubdir(resolved)) {
    return [readMemoryDir(join(resolved, MEMORY_SUBDIR))];
  }
  // A directory of *.md with no memory/ subdir — treat it as a memory dir.
  return [readMemoryDir(resolved)];
}

// ───────────────────────────── dry-run ──────────────────────────────

export interface MemoryDirCounts {
  encodedName: string;
  project: string;
  cwd?: string;
  cwdResolved: boolean;
  files: number;
  indexSkipped: boolean;
  bytes: number;
}

export interface MemoryDryRunReport {
  source: string;
  all: boolean;
  dirs: MemoryDirCounts[];
  totals: {
    dirs: number;
    /** One observation per non-index file (the store count — NO Haiku). */
    files: number;
    bytes: number;
    cwdUnresolved: number;
  };
}

/**
 * Enumerate + parse every memory dir under `source` and report what a real
 * ingest WOULD store. No DB, no Haiku — memory is stored mechanically, so the
 * file count IS the observation count (modulo content-hash dedup at store time).
 */
export function dryRunMemorySource(source: string, options: ScanOptions = {}): MemoryDryRunReport {
  const refs = scanMemorySource(source, options);
  const dirs: MemoryDirCounts[] = refs.map(ref => ({
    encodedName: ref.encodedName,
    project: ref.project,
    cwd: ref.cwd,
    cwdResolved: !!ref.cwd,
    files: ref.files.length,
    indexSkipped: !!ref.indexFile,
    bytes: ref.files.reduce((n, f) => n + f.bytes, 0),
  }));

  return {
    source: expandHome(source),
    all: !!options.all,
    dirs,
    totals: {
      dirs: dirs.length,
      files: dirs.reduce((n, d) => n + d.files, 0),
      bytes: dirs.reduce((n, d) => n + d.bytes, 0),
      cwdUnresolved: dirs.filter(d => !d.cwdResolved).length,
    },
  };
}

/** Render a dry-run report as human-readable CLI lines. */
export function formatMemoryDryRunReport(report: MemoryDryRunReport): string {
  const lines: string[] = [];
  lines.push(`Memory dry-run (no Haiku, mechanical store) — source: ${report.source}`);
  lines.push(`Mode: ${report.all ? 'all projects' : 'single'}`);
  lines.push('');
  for (const d of report.dirs) {
    const cwdTag = d.cwdResolved ? d.project : `${d.project} (cwd UNRESOLVED)`;
    lines.push(
      `${cwdTag}: ${d.files} files → ${d.files} obs, ${(d.bytes / 1024).toFixed(1)} KB` +
        (d.indexSkipped ? ', index skipped' : '')
    );
  }
  lines.push('');
  const t = report.totals;
  lines.push(
    `TOTAL: ${t.dirs} memory dirs → ${t.files} files = ~${t.files} observations ` +
      `(${(t.bytes / 1024).toFixed(1)} KB prose)`
  );
  if (t.cwdUnresolved) {
    lines.push(
      `WARNING: ${t.cwdUnresolved} dir(s) had no sibling transcript to resolve cwd — ` +
        `project key is a best-effort guess and may not merge with live capture.`
    );
  }
  lines.push('NOTE: mechanical store — memory prose is stored as-is, no model spend. Dedup by content_hash.');
  return lines.join('\n');
}

// ───────────────────────────── real ingest ──────────────────────────────
//
// The store path. Mechanical — NO Haiku. Each memory file becomes one
// observation whose `narrative` IS the file body. Runs inside the worker (the
// SQLite store lives there), driven by injected deps so it stays unit-testable
// without a live worker — mirroring the transcript ingest orchestrator.

/** One observation to store, derived purely from a memory file (no model). */
export interface MemoryObservationToStore {
  project: string;
  type: string;
  title: string;
  subtitle: string;
  narrative: string;
  concepts: string[];
  /** Backdate to the file's mtime so imported memory sorts chronologically. */
  createdAtEpoch: number;
  /** Provenance (informational; not all fields are persisted by the store). */
  sourceFile: string;
  originSessionId?: string;
}

export interface MemoryIngestDeps {
  /**
   * Persist one observation mechanically (storeObservation + Chroma sync) and
   * report whether it was newly inserted or collapsed onto an existing row by
   * content_hash. Implemented by the worker route; faked in tests.
   */
  storeMemoryObservation(obs: MemoryObservationToStore): Promise<{ id: number; deduped: boolean }>;
}

export interface MemoryIngestOptions extends ScanOptions {
  /** Skip dirs whose cwd could not be resolved (avoids best-effort project keys). */
  requireCwd?: boolean;
}

export interface MemoryFileIngestResult {
  project: string;
  file: string;
  status: 'stored' | 'deduped' | 'skipped' | 'failed';
  observationId?: number;
  reason?: string;
}

export interface MemoryIngestReport {
  source: string;
  all: boolean;
  dirs: number;
  found: number;
  stored: number;
  deduped: number;
  skipped: number;
  failed: number;
  cwdUnresolvedDirs: number;
  files: MemoryFileIngestResult[];
}

/**
 * Map a memory file onto an observation. Pure (no I/O) → directly unit-testable.
 * Provenance rides in `subtitle` + `concepts` because storeObservation does not
 * persist a metadata column.
 */
export function buildMemoryObservation(ref: MemoryDirRef, file: MemoryFileRef): MemoryObservationToStore {
  const memoryType = file.frontmatter.type ?? 'topic';
  const concepts = ['memory-import', `memory-type:${memoryType}`, `file:${file.fileName}`];
  if (file.frontmatter.originSessionId) {
    concepts.push(`origin-session:${file.frontmatter.originSessionId}`);
  }
  const description = file.frontmatter.description?.trim();
  const subtitle = description && description.length
    ? description.slice(0, 300)
    : `Imported memory (${memoryType})`;

  return {
    project: ref.project,
    type: 'discovery',
    title: file.title.slice(0, 200),
    subtitle,
    narrative: file.body,
    concepts,
    createdAtEpoch: file.mtimeEpoch,
    sourceFile: file.fileName,
    originSessionId: file.frontmatter.originSessionId,
  };
}

/**
 * Store every memory file under `source` as an observation. Idempotent by
 * content_hash (re-runs dedupe). Orphaned memory (no sibling transcript to
 * resolve cwd) is ingested by default with a best-effort project key — that is
 * the whole point of memory-direct ingest; pass `requireCwd` to skip it instead.
 */
export async function ingestMemorySource(
  source: string,
  options: MemoryIngestOptions,
  deps: MemoryIngestDeps
): Promise<MemoryIngestReport> {
  const refs = scanMemorySource(source, { all: options.all });

  const report: MemoryIngestReport = {
    source: expandHome(source),
    all: !!options.all,
    dirs: refs.length,
    found: 0,
    stored: 0,
    deduped: 0,
    skipped: 0,
    failed: 0,
    cwdUnresolvedDirs: refs.filter(r => !r.cwd).length,
    files: [],
  };

  for (const ref of refs) {
    for (const file of ref.files) {
      report.found++;
      const result: MemoryFileIngestResult = { project: ref.project, file: file.fileName, status: 'stored' };

      if (options.requireCwd && !ref.cwd) {
        result.status = 'skipped';
        result.reason = 'cwd-unresolved';
        report.skipped++;
        report.files.push(result);
        continue;
      }
      if (!file.body.trim()) {
        result.status = 'skipped';
        result.reason = 'empty-body';
        report.skipped++;
        report.files.push(result);
        continue;
      }

      try {
        const { id, deduped } = await deps.storeMemoryObservation(buildMemoryObservation(ref, file));
        result.observationId = id;
        if (deduped) {
          result.status = 'deduped';
          report.deduped++;
        } else {
          report.stored++;
        }
      } catch (err) {
        result.status = 'failed';
        result.reason = err instanceof Error ? err.message : String(err);
        report.failed++;
      }
      report.files.push(result);
    }
  }
  return report;
}
