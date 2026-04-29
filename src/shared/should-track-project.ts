
import { relative, isAbsolute } from 'path';
import { isProjectExcluded } from '../utils/project-filter.js';
import { loadFromFileOnce } from './hook-settings.js';
import { OBSERVER_SESSIONS_DIR, OBSERVER_SESSIONS_PROJECT } from './paths.js';

function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

export function shouldTrackProject(cwd: string): boolean {
  if (process.env.CLAUDE_MEM_INTERNAL === '1') return false;
  if (!cwd) return true;
  if (isWithin(cwd, OBSERVER_SESSIONS_DIR)) {
    return false;
  }
  const settings = loadFromFileOnce();
  return !isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS);
}

export function shouldEmitProjectRow(project: string | null | undefined): boolean {
  if (!project) return true;
  return project !== OBSERVER_SESSIONS_PROJECT;
}
