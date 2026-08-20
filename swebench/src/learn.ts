/**
 * /learn-codebase priming.
 *
 * The claude-mem `learn-codebase` skill reads every source file in full to
 * "front-load a cognitive cache" before work begins. This module is the
 * harness-runnable analog: it walks the checked-out repo, reads source files
 * (paging large ones, exactly as the skill instructs), and produces a compact
 * codebase map that is injected into the solver's system prompt.
 *
 * Two priming paths, both driven from here:
 *   - `buildCodebaseMap()` — always runs; deterministic, offline, per-instance
 *     priming that needs no model and no worker.
 *   - Cross-session memory — for mem_search to return real hits, the operator
 *     runs the actual `/learn-codebase` skill (or a prior work session) against
 *     the repo so observations land in claude-mem. See README "Priming memory".
 *
 * A byte/file budget bounds cost on huge repos; whatever is dropped is reported
 * (never silently truncated) so priming coverage is honest.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const SOURCE_EXTENSIONS = new Set([
  '.py', '.pyi', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.go', '.rs', '.java', '.rb', '.c', '.h', '.cc', '.cpp', '.hpp',
  '.cs', '.php', '.scala', '.kt', '.swift', '.sh',
]);

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'vendor', '__pycache__',
  '.tox', '.venv', 'venv', 'env', '.mypy_cache', '.pytest_cache',
  '.eggs', 'site-packages', '.idea', '.vscode', 'coverage', '.next',
]);

export interface LearnOptions {
  /** Stop after reading this many source files (default 400). */
  maxFiles?: number;
  /** Stop after reading this many total bytes (default 4 MiB). */
  maxBytes?: number;
  /** Per-file byte cap before paging/truncation note (default 24 KiB). */
  maxBytesPerFile?: number;
}

export interface FileSummary {
  path: string;
  bytes: number;
  /** Whether the file body was truncated to fit the per-file cap. */
  truncated: boolean;
  /** The (possibly truncated) source text used for priming. */
  content: string;
}

export interface CodebaseMap {
  root: string;
  fileTree: string[];
  files: FileSummary[];
  totalFilesSeen: number;
  totalFilesRead: number;
  totalBytesRead: number;
  /** Files skipped because a budget was hit — reported, never silent. */
  droppedForBudget: number;
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!IGNORE_DIRS.has(name)) walk(full);
      } else if (st.isFile() && SOURCE_EXTENSIONS.has(extname(name))) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Read repo source files into a bounded, priming-ready codebase map. */
export function buildCodebaseMap(root: string, opts: LearnOptions = {}): CodebaseMap {
  const maxFiles = opts.maxFiles ?? 400;
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
  const maxBytesPerFile = opts.maxBytesPerFile ?? 24 * 1024;

  const all = listSourceFiles(root);
  const files: FileSummary[] = [];
  let totalBytesRead = 0;
  let dropped = 0;

  for (const full of all) {
    if (files.length >= maxFiles || totalBytesRead >= maxBytes) {
      dropped++;
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    const truncated = Buffer.byteLength(raw, 'utf-8') > maxBytesPerFile;
    const content = truncated ? raw.slice(0, maxBytesPerFile) : raw;
    const bytes = Buffer.byteLength(content, 'utf-8');
    totalBytesRead += bytes;
    files.push({ path: relative(root, full), bytes, truncated, content });
  }

  return {
    root,
    fileTree: all.map((f) => relative(root, f)),
    files,
    totalFilesSeen: all.length,
    totalFilesRead: files.length,
    totalBytesRead,
    droppedForBudget: dropped,
  };
}

/**
 * Render the codebase map as a system-prompt priming block. Kept compact: a
 * file tree plus each read file's (possibly truncated) body, with an explicit
 * note when coverage was bounded so the model knows the map is partial.
 */
export function renderPrimingBlock(map: CodebaseMap): string {
  const lines: string[] = [];
  lines.push('# Codebase priming (/learn-codebase)');
  lines.push('');
  lines.push(
    `Read ${map.totalFilesRead}/${map.totalFilesSeen} source files (${(map.totalBytesRead / 1024).toFixed(0)} KiB).` +
      (map.droppedForBudget > 0
        ? ` ${map.droppedForBudget} file(s) were NOT read due to the priming budget — use bash to open any file you need that is missing below.`
        : ''),
  );
  lines.push('');
  lines.push('## File tree');
  lines.push('```');
  lines.push(...map.fileTree.slice(0, 2000));
  if (map.fileTree.length > 2000) lines.push(`... and ${map.fileTree.length - 2000} more`);
  lines.push('```');
  lines.push('');
  lines.push('## Source files');
  for (const f of map.files) {
    lines.push(`### ${f.path}${f.truncated ? ' (truncated)' : ''}`);
    lines.push('```');
    lines.push(f.content.replace(/```/g, '``​`'));
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

/** Convenience: build + render in one call. */
export function primeFromRepo(root: string, opts: LearnOptions = {}): { map: CodebaseMap; block: string } {
  const map = buildCodebaseMap(root, opts);
  return { map, block: renderPrimingBlock(map) };
}
