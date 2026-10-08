import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isWithinMemoryRoot, type MemoryWatchRoot } from './config.js';
import type { SaveMemoryInput } from './save-memory.js';
import { logger } from '../../utils/logger.js';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES_PER_ROOT = 500;
const SELF_BLOCK = /<!-- claude-mem-memory-instructions:start -->[\s\S]*?<!-- claude-mem-memory-instructions:end -->/g;

interface Candidate { hash: string; firstSeen: number; saved: boolean; signature: string; }

/**
 * Polling catches new files, atomic renames and missing roots on every platform.
 * Only explicit roots are read; no global memory-folder discovery for ingestion.
 * Exact fingerprints are checked at the DB boundary, so no checkpoint file or
 * second source of truth is needed. Source files are never modified.
 */
export class MemoryFileWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private candidates = new Map<string, Candidate>();
  private stopped = false;

  constructor(
    private roots: MemoryWatchRoot[],
    private save: (input: SaveMemoryInput) => unknown,
    private debounceMs = 400,
    private pollMs = 1_000,
  ) {}

  start(): void {
    if (this.timer || this.roots.length === 0) return;
    this.stopped = false;
    this.scan();
    this.timer = setInterval(() => this.scan(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  scan(now = Date.now()): void {
    if (this.stopped) return;
    const seen = new Set<string>();
    for (const root of this.roots) {
      let canonicalRoot: string;
      try {
        if (lstatSync(root.path).isSymbolicLink()) continue;
        canonicalRoot = realpathSync(root.path);
      } catch { continue; }
      const files = this.listMarkdown(root.path);
      for (const file of files) {
        const key = `${root.project}\0${file}`;
        seen.add(key);
        try {
          const stat = lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES || !isWithinMemoryRoot(realpathSync(file), canonicalRoot)) continue;
          const signature = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
          const prior = this.candidates.get(key);
          if (prior?.saved && prior.signature === signature) continue;
          const text = this.readMarkdown(file, canonicalRoot).replace(SELF_BLOCK, '').trim();
          if (!text) continue;
          const hash = createHash('sha256').update(text).digest('hex');
          if (!prior || prior.hash !== hash) {
            this.candidates.set(key, { hash, firstSeen: now, saved: false, signature });
            continue;
          }
          prior.signature = signature;
          if (prior.saved || now - prior.firstSeen < this.debounceMs) continue;
          const fingerprint = createHash('sha256').update(`${root.project}\0${file}\0${hash}`).digest('hex');
          // SessionStore's optional Tier-0 dedup keys on title, not narrative.
          // Give each content revision a distinct title so edited notes survive.
          this.save({ text, title: `Memory file: ${path.relative(root.path, file)} (revision ${hash.slice(0, 16)})`, project: root.project,
            metadata: { source: 'memory-file', sourcePath: file, sourceFingerprint: fingerprint, contentHash: hash, ...(root.platformSource ? { platformSource: root.platformSource } : {}) } });
          prior.saved = true;
        } catch (error) {
          logger.debug('HOOK', 'Memory file bridge skipped a file', { path: file, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    for (const key of this.candidates.keys()) if (!seen.has(key)) this.candidates.delete(key);
  }

  private readMarkdown(file: string, root: string): string {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || !isWithinMemoryRoot(realpathSync(file), root)) throw new Error('Memory file moved outside watched root');
      return readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  }

  private listMarkdown(root: string): string[] {
    const result: string[] = [];
    const visit = (directory: string, depth: number) => {
      if (depth > 8 || result.length >= MAX_FILES_PER_ROOT) return;
      let entries;
      try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (result.length >= MAX_FILES_PER_ROOT) break;
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file, depth + 1);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) result.push(file);
      }
    };
    visit(root, 0);
    return result;
  }
}
