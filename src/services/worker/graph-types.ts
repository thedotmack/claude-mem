/**
 * Graph visualization types for claude-mem viewer
 * Used by GraphService and GraphRoutes to provide graph data to the UI
 */

// ========== Concept Network Graph ==========

export interface ConceptNode {
  /** Concept name (lowercase, hyphenated) */
  id: string;
  /** Display label */
  label: string;
  /** Number of observations with this concept */
  size: number;
  /** Projects that use this concept */
  projects: string[];
  /** Most recent usage timestamp (epoch ms) */
  lastUsed: number;
}

export interface ConceptEdge {
  /** Source concept ID */
  source: string;
  /** Target concept ID */
  target: string;
  /** Number of observations where both concepts appear together */
  weight: number;
  /** Projects where this co-occurrence happens */
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

// ========== Observation Relationship Graph ==========

export interface ObservationNode {
  /** Observation ID */
  id: number;
  /** Observation title */
  title: string;
  /** Observation type (bugfix, feature, etc.) */
  type: string;
  /** Project name */
  project: string;
  /** Number of times this observation was accessed */
  usageCount: number;
  /** Creation timestamp (epoch ms) */
  createdAt: number;
  /** Last access timestamp (epoch ms) or null */
  lastAccessed: number | null;
}

export interface ObservationEdge {
  /** Source observation ID */
  source: number;
  /** Target observation ID */
  target: number;
  /** Type of relationship */
  relationship: 'shared_concept' | 'shared_file' | 'semantic_similar' | 'same_session';
  /** Connection strength (higher = stronger relationship) */
  weight: number;
  /** Detail about the connection (e.g., shared concept name) */
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

// ========== Project Connection Graph ==========

export interface ProjectNode {
  /** Project name */
  id: string;
  /** Number of observations in project */
  observationCount: number;
  /** Number of unique concepts in project */
  conceptCount: number;
  /** Most common observation types */
  topTypes: { type: string; count: number }[];
  /** Last activity timestamp (epoch ms) */
  lastActivity: number;
}

export interface ProjectEdge {
  /** Source project ID */
  source: string;
  /** Target project ID */
  target: string;
  /** Concepts shared between projects */
  sharedConcepts: string[];
  /** Connection strength based on shared concepts */
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

// ========== Usage Statistics ==========

export interface UsageStatsEntry {
  /** Observation ID */
  id: number;
  /** Observation title */
  title: string;
  /** Observation subtitle */
  subtitle: string | null;
  /** Observation type */
  type: string;
  /** Project name */
  project: string;
  /** Total access count */
  usageCount: number;
  /** Last access timestamp */
  lastAccessed: string | null;
  /** Creation timestamp (epoch ms) */
  createdAt: number;
  /** Access breakdown by type */
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

// ========== Cross-Project Insights ==========

export interface CrossProjectPattern {
  /** Pattern ID (concept or concept pair) */
  id: string;
  /** Type of pattern */
  patternType: 'shared_concept' | 'problem_solution' | 'common_approach' | 'tech_stack';
  /** Human-readable description */
  description: string;
  /** Projects that share this pattern */
  projects: string[];
  /** Number of observations with this pattern */
  observationCount: number;
  /** Sample observation IDs */
  sampleObservationIds: number[];
  /** Strength score (0-1) */
  strength: number;
}

export interface ProjectSynergy {
  /** First project */
  project1: string;
  /** Second project */
  project2: string;
  /** Shared patterns between projects */
  sharedPatterns: string[];
  /** Synergy score (0-1) based on overlap */
  synergyScore: number;
  /** Potential learnings project1 could apply from project2 */
  potentialLearnings: string[];
}

export interface ProblemSolutionCluster {
  /** Cluster ID */
  id: string;
  /** Problem type or description */
  problemType: string;
  /** Observations in this cluster */
  observations: Array<{
    id: number;
    title: string;
    project: string;
    type: string;
  }>;
  /** Common approaches used */
  commonApproaches: string[];
  /** Projects that solved similar problems */
  projectsInvolved: string[];
}

export interface InsightsData {
  /** Cross-project patterns */
  crossProjectPatterns: CrossProjectPattern[];
  /** Project synergies (pairs of projects with high overlap) */
  projectSynergies: ProjectSynergy[];
  /** Problem-solution clusters */
  problemClusters: ProblemSolutionCluster[];
  /** Summary statistics */
  summary: {
    totalPatterns: number;
    totalSynergies: number;
    totalClusters: number;
    mostConnectedProjects: string[];
    topSharedConcepts: string[];
  };
}

// ========== Session Clustering ==========

export interface SessionCluster {
  /** Session ID */
  sessionId: string;
  /** Project */
  project: string;
  /** Observations in this session */
  observations: ObservationNode[];
  /** Session start time */
  startTime: number;
  /** Session end time */
  endTime: number;
  /** Main concepts in this session */
  mainConcepts: string[];
  /** Session type based on observation types */
  sessionType: 'feature_work' | 'bug_fixing' | 'refactoring' | 'exploration' | 'mixed';
}

export interface SessionClusteredData {
  clusters: SessionCluster[];
  standaloneObservations: ObservationNode[];
  stats: {
    totalSessions: number;
    avgObservationsPerSession: number;
    longestSession: string;
    mostProductiveSession: string;
  };
}

// ========== API Response Types ==========

export interface GraphApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
