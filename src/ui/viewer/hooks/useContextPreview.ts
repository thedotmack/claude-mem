import { useState, useEffect, useCallback } from 'react';
import type { ProjectCatalog, Settings } from '../types';

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
    async function fetchProjects() {
      let data: ProjectCatalog;
      try {
        const response = await fetch('/api/projects');
        data = await response.json() as ProjectCatalog;
      } catch (err: unknown) {
        console.error('Failed to fetch projects:', err instanceof Error ? err.message : String(err));
        return;
      }

      const nextCatalog: ProjectCatalog = {
        projects: data.projects || [],
        sources: withDefaultSources(data.sources || []),
        projectsBySource: data.projectsBySource || {}
      };

      setCatalog(nextCatalog);

      const preferredSource = getPreferredSource(nextCatalog.sources);
      setSelectedSource(preferredSource);

      if (preferredSource) {
        const sourceProjects = nextCatalog.projectsBySource[preferredSource] || [];
        setProjects(sourceProjects);
        setSelectedProject(sourceProjects[0] || null);
        return;
      }

      setProjects(nextCatalog.projects);
      setSelectedProject(nextCatalog.projects[0] || null);
    }
    fetchProjects();
  }, []);

  const refresh = useCallback(async () => {
    if (!selectedProject) {
      setPreview('No project selected');
      return;
    }

    setIsLoading(true);
    setError(null);

    const params = new URLSearchParams({
      project: selectedProject
    });

    try {
      const response = await fetch(`/api/context/preview?${params}`);
      const text = await response.text();

      if (response.ok) {
        setPreview(text);
      } else {
        setError('Failed to load preview');
      }
    } catch (error: unknown) {
      console.error('Failed to load context preview:', error instanceof Error ? error.message : String(error));
      setError('Failed to load preview');
    }

    setIsLoading(false);
  }, [selectedProject]);

  // Debounced refresh when settings or selectedProject change
  useEffect(() => {
    const timeout = setTimeout(() => {
      refresh();
    }, 300);
    return () => clearTimeout(timeout);
  }, [settings, refresh]);

  return {
    preview,
    isLoading,
    error,
    refresh,
    projects,
    selectedProject,
    setSelectedProject
  };
}
