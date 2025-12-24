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

// Health data types
export interface HealthSummary {
  totalLogs: number;
  errorCount24h: number;
  warnCount24h: number;
  unresolvedPatterns: number;
  topErrors: Array<{ message: string; count: number; component: string }>;
  componentErrorCounts: Record<string, number>;
  status: 'healthy' | 'warning' | 'critical';
}

export interface SystemLogEntry {
  id: number;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  component: string;
  message: string;
  context: string | null;
  data: string | null;
  error_stack: string | null;
  created_at: string;
  created_at_epoch: number;
}

export interface HealthData {
  summary: HealthSummary;
  recentLogs: SystemLogEntry[];
}

// Cross-project insights types
export interface CrossProjectPattern {
  id: string;
  patternType: 'shared_concept' | 'problem_solution' | 'common_approach' | 'tech_stack';
  description: string;
  projects: string[];
  observationCount: number;
  sampleObservationIds: number[];
  strength: number;
}

export interface ProjectSynergy {
  project1: string;
  project2: string;
  sharedPatterns: string[];
  synergyScore: number;
  potentialLearnings: string[];
}

export interface ProblemSolutionCluster {
  id: string;
  problemType: string;
  observations: Array<{
    id: number;
    title: string;
    project: string;
    type: string;
  }>;
  commonApproaches: string[];
  projectsInvolved: string[];
}

export interface InsightsData {
  crossProjectPatterns: CrossProjectPattern[];
  projectSynergies: ProjectSynergy[];
  problemClusters: ProblemSolutionCluster[];
  summary: {
    totalPatterns: number;
    totalSynergies: number;
    totalClusters: number;
    mostConnectedProjects: string[];
    topSharedConcepts: string[];
  };
}

export type GraphTab = 'concepts' | 'observations' | 'projects' | 'usage' | 'insights' | 'health';

interface GraphState {
  conceptData: ConceptGraphData | null;
  observationData: ObservationGraphData | null;
  projectData: ProjectGraphData | null;
  usageData: UsageStatsData | null;
  insightsData: InsightsData | null;
  healthData: HealthData | null;
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
    insightsData: null,
    healthData: null,
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

  const fetchInsightsData = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const response = await fetch(`${API_ENDPOINTS.GRAPH_INSIGHTS}?limit=50`, {
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) throw new Error(`Failed to fetch insights: ${response.statusText}`);

      const result = await response.json();
      setState(prev => ({
        ...prev,
        insightsData: result.data,
        isLoading: false
      }));
    } catch (error: any) {
      if (error.name === 'AbortError') return;
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error.message || 'Failed to fetch insights'
      }));
    }
  }, []);

  const fetchHealthData = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      // Fetch both summary and recent logs in parallel
      const [summaryResponse, logsResponse] = await Promise.all([
        fetch(`${API_ENDPOINTS.HEALTH_SUMMARY}`, {
          signal: abortControllerRef.current.signal
        }),
        fetch(`${API_ENDPOINTS.LOGS}?limit=50`, {
          signal: abortControllerRef.current.signal
        })
      ]);

      if (!summaryResponse.ok) throw new Error(`Failed to fetch health summary: ${summaryResponse.statusText}`);
      if (!logsResponse.ok) throw new Error(`Failed to fetch logs: ${logsResponse.statusText}`);

      const [summaryResult, logsResult] = await Promise.all([
        summaryResponse.json(),
        logsResponse.json()
      ]);

      setState(prev => ({
        ...prev,
        healthData: {
          summary: summaryResult.data,
          recentLogs: logsResult.data.logs
        },
        isLoading: false
      }));
    } catch (error: any) {
      if (error.name === 'AbortError') return;
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error.message || 'Failed to fetch health data'
      }));
    }
  }, []);

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
      case 'insights':
        fetchInsightsData();
        break;
      case 'health':
        fetchHealthData();
        break;
    }
  }, [state.activeTab, project, fetchConceptGraph, fetchObservationGraph, fetchProjectGraph, fetchUsageStats, fetchInsightsData, fetchHealthData]);

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
      case 'insights':
        fetchInsightsData();
        break;
      case 'health':
        fetchHealthData();
        break;
    }
  }, [state.activeTab, fetchConceptGraph, fetchObservationGraph, fetchProjectGraph, fetchUsageStats, fetchInsightsData, fetchHealthData]);

  return {
    conceptData: state.conceptData,
    observationData: state.observationData,
    projectData: state.projectData,
    usageData: state.usageData,
    insightsData: state.insightsData,
    healthData: state.healthData,
    isLoading: state.isLoading,
    error: state.error,
    activeTab: state.activeTab,
    setActiveTab,
    refresh
  };
}
