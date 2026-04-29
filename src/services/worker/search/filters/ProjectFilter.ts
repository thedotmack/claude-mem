
import { basename } from 'path';
import { logger } from '../../../../utils/logger.js';

export function getCurrentProject(): string {
  return basename(process.cwd());
}

export function normalizeProject(project?: string): string | undefined {
  if (!project) {
    return undefined;
  }

  const trimmed = project.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

export function matchesProject(
  resultProject: string,
  filterProject?: string
): boolean {
  if (!filterProject) {
    return true;
  }

  return resultProject === filterProject;
}

export function filterResultsByProject<T extends { project: string }>(
  results: T[],
  project?: string
): T[] {
  if (!project) {
    return results;
  }

  return results.filter(result => matchesProject(result.project, project));
}
