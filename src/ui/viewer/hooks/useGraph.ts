import { useState, useEffect, useCallback, useRef } from 'react';
import { API_ENDPOINTS } from '../constants/api';

// Graph data types (matching server-side types)
export interface ConceptNode {
  id: string;
  label: string;
  size: number;
  projects: string[];
  lastUsed: number;
}

export interface ConceptEdge {
  source: string;
  target: string;
  weight: number;
  projects: string[];
}

export interface ConceptGraphData {
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  stats: {
    totalConcepts: number;
    totalEdges: number;
    mostConnected: string[];
  };
}

export interface ObservationNode {
  id: number;
  title: string;
  type: string;
  project: string;
  usageCount: number;
  createdAt: number;
  lastAccessed: number | null;
}

export interface ObservationEdge {
  source: number;
  target: number;
  relationship: 'shared_concept' | 'shared_file' | 'semantic_similar' | 'same_session';
  weight: number;
  detail?: string;
}

export interface ObservationGraphData {
  nodes: ObservationNode[];
  edges: ObservationEdge[];
  stats: {
    totalObservations: number;
    totalEdges: number;
    avgConnections: number;
    clusters: number;
  };
}

export interface ProjectNode {
  id: string;
  observationCount: number;
  conceptCount: number;
  topTypes: { type: string; count: number }[];
  lastActivity: number;
}

export interface ProjectEdge {
  source: string;
  target: string;
  sharedConcepts: string[];
  weight: number;
}

export interface ProjectGraphData {
  nodes: ProjectNode[];
  edges: ProjectEdge[];
  stats: {
    totalProjects: number;
    totalConnections: number;
    mostConnected: string[];
  };
}

export interface UsageStatsEntry {
  id: number;
  title: string;
  subtitle: string | null;
  type: string;
  project: string;
  usageCount: number;
  lastAccessed: string | null;
  createdAt: number;
  accessByType: {
    context_injection: number;
    search_result: number;
    manual_view: number;
  };
}

export interface UsageStatsData {
  entries: UsageStatsEntry[];
  summary: {
    totalAccesses: number;
    totalObservationsAccessed: number;
    avgAccessesPerObservation: number;
    topAccessType: 'context_injection' | 'search_result' | 'manual_view';
  };
}

export type GraphTab = 'concepts' | 'observations' | 'projects' | 'usage';

interface GraphState {
  conceptData: ConceptGraphData | null;
  observationData: ObservationGraphData | null;
  projectData: ProjectGraphData | null;
  usageData: UsageStatsData | null;
  isLoading: boolean;
  error: string | null;
  activeTab: GraphTab;
}

/**
 * Hook for fetching graph visualization data
 * Fetches data only for the active tab to minimize load
 */
export function useGraph(project?: string) {
  const [state, setState] = useState<GraphState>({
    conceptData: null,
    observationData: null,
    projectData: null,
    usageData: null,
    isLoading: false,
    error: null,
    activeTab: 'concepts'
  });

  const abortControllerRef = useRef<AbortController | null>(null);

  const setActiveTab = useCallback((tab: GraphTab) => {
    setState(prev => ({ ...prev, activeTab: tab }));
  }, []);

  const fetchConceptGraph = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const params = new URLSearchParams({ limit: '100' });
      if (project) params.append('project', project);

      const response = await fetch(`${API_ENDPOINTS.GRAPH_CONCEPTS}?${params}`, {
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) throw new Error(`Failed to fetch concept graph: ${response.statusText}`);

      const result = await response.json();
      setState(prev => ({
        ...prev,
        conceptData: result.data,
        isLoading: false
      }));
    } catch (error: any) {
      if (error.name === 'AbortError') return;
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error.message || 'Failed to fetch concept graph'
      }));
    }
  }, [project]);

  const fetchObservationGraph = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const params = new URLSearchParams({ limit: '200' });
      if (project) params.append('project', project);

      const response = await fetch(`${API_ENDPOINTS.GRAPH_OBSERVATIONS}?${params}`, {
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) throw new Error(`Failed to fetch observation graph: ${response.statusText}`);

      const result = await response.json();
      setState(prev => ({
        ...prev,
        observationData: result.data,
        isLoading: false
      }));
    } catch (error: any) {
      if (error.name === 'AbortError') return;
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error.message || 'Failed to fetch observation graph'
      }));
    }
  }, [project]);

  const fetchProjectGraph = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const response = await fetch(API_ENDPOINTS.GRAPH_PROJECTS, {
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) throw new Error(`Failed to fetch project graph: ${response.statusText}`);

      const result = await response.json();
      setState(prev => ({
        ...prev,
        projectData: result.data,
        isLoading: false
      }));
    } catch (error: any) {
      if (error.name === 'AbortError') return;
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error.message || 'Failed to fetch project graph'
      }));
    }
  }, []);

  const fetchUsageStats = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const params = new URLSearchParams({ limit: '50' });
      if (project) params.append('project', project);

      const response = await fetch(`${API_ENDPOINTS.GRAPH_USAGE_STATS}?${params}`, {
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) throw new Error(`Failed to fetch usage stats: ${response.statusText}`);

      const result = await response.json();
      setState(prev => ({
        ...prev,
        usageData: result.data,
        isLoading: false
      }));
    } catch (error: any) {
      if (error.name === 'AbortError') return;
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error.message || 'Failed to fetch usage stats'
      }));
    }
  }, [project]);

  // Fetch data when active tab or project changes
  useEffect(() => {
    switch (state.activeTab) {
      case 'concepts':
        fetchConceptGraph();
        break;
      case 'observations':
        fetchObservationGraph();
        break;
      case 'projects':
        fetchProjectGraph();
        break;
      case 'usage':
        fetchUsageStats();
        break;
    }
  }, [state.activeTab, project, fetchConceptGraph, fetchObservationGraph, fetchProjectGraph, fetchUsageStats]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const refresh = useCallback(() => {
    switch (state.activeTab) {
      case 'concepts':
        fetchConceptGraph();
        break;
      case 'observations':
        fetchObservationGraph();
        break;
      case 'projects':
        fetchProjectGraph();
        break;
      case 'usage':
        fetchUsageStats();
        break;
    }
  }, [state.activeTab, fetchConceptGraph, fetchObservationGraph, fetchProjectGraph, fetchUsageStats]);

  return {
    conceptData: state.conceptData,
    observationData: state.observationData,
    projectData: state.projectData,
    usageData: state.usageData,
    isLoading: state.isLoading,
    error: state.error,
    activeTab: state.activeTab,
    setActiveTab,
    refresh
  };
}
