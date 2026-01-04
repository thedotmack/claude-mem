/**
 * ProjectFilter - Project scoping for search results
 *
 * Provides utilities for filtering search results by project.
 */

import { basename } from 'path';
import { logger } from '../../../../utils/logger.js';

/**
 * Get the current project name from cwd
 */
export function getCurrentProject(): string {
  return basename(process.cwd());
}

/**
 * Normalize project name for filtering
 */
export function normalizeProject(project?: string): string | undefined {
  if (!project) {
    return undefined;
  }

  // Remove leading/trailing whitespace
  const trimmed = project.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

/**
 * Check if a result matches the project filter
 */
export function matchesProject(
  resultProject: string,
  filterProject?: string
): boolean {
  if (!filterProject) {
    return true;
  }

  return resultProject === filterProject;
}

/**
 * Filter results by project
 */
export function filterResultsByProject<T extends { project: string }>(
  results: T[],
  project?: string
): T[] {
  if (!project) {
    return results;
  }

  return results.filter(result => matchesProject(result.project, project));
}
