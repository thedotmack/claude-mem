import { useState, useCallback } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import { logger } from '../utils/logger';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Mirrors ProjectRowCounts in src/services/sqlite/ProjectOperations.ts */
export interface ProjectRowCounts {
  sdk_sessions: number;
  observations: number;
  session_summaries: number;
  context_injections: number;
}

export interface UseProjectActionsResult {
  getRowCounts: (project: string) => Promise<ProjectRowCounts>;
  renameProject: (project: string, newName: string) => Promise<ProjectRowCounts>;
  mergeProject: (source: string, target: string) => Promise<ProjectRowCounts>;
  deleteProject: (project: string) => Promise<ProjectRowCounts>;
  isLoading: boolean;
  error: string | null;
}

interface ProjectActionResponse {
  counts: ProjectRowCounts;
  error?: string;
}

export function useProjectActions(): UseProjectActionsResult {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Shared fetch wrapper that manages loading/error state for all project actions. */
  const executeAction = useCallback(async (
    url: string,
    actionLabel: string,
    options?: RequestInit,
  ): Promise<ProjectRowCounts> => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(url, options);
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        throw new Error(`${actionLabel} failed: server returned non-JSON response`);
      }
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error ?? `${actionLabel} failed`);
      }
      const data = await response.json() as ProjectActionResponse;
      return data.counts;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      logger.error('useProjectActions', `${actionLabel} failed: ${message}`);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const projectUrl = useCallback((project: string, path = ''): string =>
    `${API_ENDPOINTS.PROJECTS_BASE}/${encodeURIComponent(project)}${path}`,
  []);

  const getRowCounts = useCallback(
    (project: string) => executeAction(projectUrl(project, '/counts'), 'getRowCounts'),
    [executeAction, projectUrl],
  );

  const renameProject = useCallback(
    (project: string, newName: string) => executeAction(
      projectUrl(project, '/rename'),
      'renameProject',
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ newName }) },
    ),
    [executeAction, projectUrl],
  );

  const mergeProject = useCallback(
    (source: string, target: string) => executeAction(
      projectUrl(source, '/merge'),
      'mergeProject',
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ targetProject: target }) },
    ),
    [executeAction, projectUrl],
  );

  const deleteProject = useCallback(
    (project: string) => executeAction(
      projectUrl(project),
      'deleteProject',
      { method: 'DELETE' },
    ),
    [executeAction, projectUrl],
  );

  return {
    getRowCounts,
    renameProject,
    mergeProject,
    deleteProject,
    isLoading,
    error,
  };
}
