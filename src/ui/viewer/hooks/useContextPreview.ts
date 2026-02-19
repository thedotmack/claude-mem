import { useState, useEffect, useCallback, useRef } from 'react';
import type { Settings } from '../types';
import { logger } from '../utils/logger';

interface UseContextPreviewResult {
  preview: string;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  projects: string[];
  selectedProject: string | null;
  setSelectedProject: (project: string) => void;
}

export function useContextPreview(settings: Settings): UseContextPreviewResult {
  const [preview, setPreview] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  // Fetch projects on mount
  useEffect(() => {
    const controller = new AbortController();
    async function fetchProjects() {
      try {
        const response = await fetch('/api/projects', { signal: controller.signal });
        const data = await response.json() as { projects?: string[] };
        if (data.projects && data.projects.length > 0) {
          setProjects(data.projects);
          setSelectedProject(data.projects[0]);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        logger.error('contextPreview', 'Failed to fetch projects');
      }
    }
    void fetchProjects();
    return () => { controller.abort(); };
  }, []);

  const refreshAbortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!selectedProject) {
      setPreview('No project selected');
      return;
    }

    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        project: selectedProject
      });

      const response = await fetch(`/api/context/preview?${params}`, { signal: controller.signal });
      const text = await response.text();

      if (controller.signal.aborted) return;

      if (response.ok) {
        setPreview(text);
      } else {
        setError('Failed to load preview');
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      logger.error('contextPreview', 'Network error loading preview');
      setError('Unable to load preview. Check that the worker is running.');
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, [selectedProject]);

  // Debounced refresh when settings or selectedProject change
  useEffect(() => {
    const timeout = setTimeout(() => {
      void refresh();
    }, 300);
    return () => {
      clearTimeout(timeout);
      refreshAbortRef.current?.abort();
    };
  }, [settings, refresh]);

  return { preview, isLoading, error, refresh, projects, selectedProject, setSelectedProject };
}
