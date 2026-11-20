import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../i18n';
import type { ProjectCatalog, Settings } from '../types';

interface UseContextPreviewResult {
  preview: string;
  /** True while a read is on its way, and while the preview shown is still the one for an earlier source or project. */
  isLoading: boolean;
  error: string | null;
  projects: string[];
  sources: string[];
  selectedSource: string | null;
  setSelectedSource: (source: string) => void;
  selectedProject: string | null;
  setSelectedProject: (project: string) => void;
}

function getPreferredSource(catalog: ProjectCatalog): string | null {
  const sources = catalog.sources.filter(source => (catalog.projectsBySource[source]?.length ?? 0) > 0);
  if (sources.includes('claude')) return 'claude';
  if (sources.includes('codex')) return 'codex';
  return sources[0] || null;
}

/** Which source and project a preview was read for. */
function selectionKey(source: string | null, project: string | null): string {
  return JSON.stringify([source ?? '', project ?? '']);
}

function withDefaultSources(sources: string[]): string[] {
  const merged = ['claude', 'codex', ...sources];
  return Array.from(new Set(merged));
}

export function useContextPreview(settings: Settings): UseContextPreviewResult {
  const { t } = useI18n();
  const [preview, setPreview] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ProjectCatalog>({ projects: [], sources: [], projectsBySource: {} });
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  // The source and project the shown preview (or its error) was read for. A new choice reads after a 300 ms pause,
  // and until its preview arrives the old one's counts must not stand beside the new choice's name.
  const [shownFor, setShownFor] = useState<string | null>(null);
  const currentSelection = selectionKey(selectedSource, selectedProject);

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

      const preferredSource = settings.CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES === 'true'
        ? null
        : getPreferredSource(nextCatalog);
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
    setSelectedSource(settings.CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES === 'true'
      ? null
      : getPreferredSource(catalog));
  }, [settings.CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES, catalog]);

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

  const refresh = useCallback(async (isCurrent: () => boolean) => {
    const readFor = selectionKey(selectedSource, selectedProject);
    if (!selectedProject) {
      setPreview('No project selected');
      setShownFor(readFor);
      setIsLoading(false);
      setError(null);
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
      const response = await fetch(`/api/context/preview?${params}`);
      const text = await response.text();
      if (!isCurrent()) return;

      if (response.ok) {
        setPreview(text);
      } else {
        setError('Failed to load preview');
      }
      setShownFor(readFor);
    } catch (error: unknown) {
      console.error('Failed to load context preview:', error instanceof Error ? error.message : String(error));
      if (isCurrent()) {
        setError('Failed to load preview');
        setShownFor(readFor);
      }
    }

    if (isCurrent()) setIsLoading(false);
  }, [selectedProject, selectedSource]);

  useEffect(() => {
    let current = true;
    const timeout = setTimeout(() => {
      refresh(() => current);
    }, 300);
    return () => {
      current = false;
      clearTimeout(timeout);
    };
  }, [settings, refresh]);

  const stale = shownFor !== currentSelection;
  return {
    preview: preview === 'No project selected' ? t(preview) : preview,
    isLoading: isLoading || stale,
    // An error read for an earlier choice is not this choice's: the preview says it is loading instead.
    error: error && !stale ? t(error) : null,
    projects,
    sources: catalog.sources,
    selectedSource,
    setSelectedSource,
    selectedProject,
    setSelectedProject
  };
}
