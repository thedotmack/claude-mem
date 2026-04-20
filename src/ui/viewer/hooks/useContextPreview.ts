import { useState, useEffect, useCallback } from 'react';
import type { ProjectCatalog, Settings } from '../types';
import { authFetch } from '../utils/api';

interface UseContextPreviewResult {
  preview: string;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  projects: string[];
  sources: string[];
  selectedSource: string | null;
  setSelectedSource: (source: string) => void;
  selectedProject: string | null;
  setSelectedProject: (project: string) => void;
}

function getPreferredSource(sources: string[]): string | null {
  if (sources.includes('claude')) return 'claude';
  if (sources.includes('codex')) return 'codex';
  return sources[0] || null;
}

function withDefaultSources(sources: string[]): string[] {
  const merged = ['claude', 'codex', ...sources];
  return Array.from(new Set(merged));
}

export function useContextPreview(settings: Settings): UseContextPreviewResult {
  const [preview, setPreview] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ProjectCatalog>({ projects: [], sources: [], projectsBySource: {} });
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  // Fetch projects on mount
  useEffect(() => {
    async function fetchProjects() {
      let data: ProjectCatalog;
      try {
        const response = await authFetch('/api/projects');
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

  useEffect(() => {
    if (!selectedSource) {
      setProjects(catalog.projects);
      setSelectedProject(prev => (prev && catalog.projects.includes(prev) ? prev : catalog.projects[0] || null));
      return;
    }

    const sourceProjects = catalog.projectsBySource[selectedSource] || [];
    setProjects(sourceProjects);
    setSelectedProject(prev => (prev && sourceProjects.includes(prev) ? prev : sourceProjects[0] || null));
  }, [catalog, selectedSource]);

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

    if (selectedSource) {
      params.append('platformSource', selectedSource);
    }

    try {
      const response = await authFetch(`/api/context/preview?${params}`);
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
  }, [selectedProject, selectedSource]);

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
    sources: catalog.sources,
    selectedSource,
    setSelectedSource,
    selectedProject,
    setSelectedProject
  };
}
