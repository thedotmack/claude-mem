import { homedir } from 'node:os';
import path from 'node:path';

export interface MemoryWatchRoot {
  path: string;
  project: string;
  platformSource?: string;
}

export function expandMemoryPath(value: string): string {
  return value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : path.resolve(value);
}

/** Watching is opt-in, including the target project; never guess ownership. */
export function parseMemoryWatchRoots(value: string | undefined): MemoryWatchRoot[] {
  if (!value?.trim()) return [];
  const rows: unknown = JSON.parse(value);
  if (!Array.isArray(rows) || rows.length > 8) throw new Error('Memory watch roots must be an array of at most 8 entries');
  return rows.map(row => {
    if (!row || typeof row !== 'object') throw new Error('Invalid memory watch root');
    const r = row as Record<string, unknown>;
    if (typeof r.path !== 'string' || (!path.isAbsolute(r.path) && !r.path.startsWith('~/')) || typeof r.project !== 'string' || !r.project.trim()) {
      throw new Error('Each memory watch root requires an absolute path and a project');
    }
    return { path: expandMemoryPath(r.path), project: r.project.trim(), ...(typeof r.platformSource === 'string' ? { platformSource: r.platformSource } : {}) };
  });
}

export function isWithinMemoryRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
