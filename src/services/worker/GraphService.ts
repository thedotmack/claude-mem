/**
 * GraphService - Builds graph data structures from claude-mem observations
 * Provides data for concept networks, observation relationships, and project connections
 */

import { SessionStore } from '../sqlite/SessionStore.js';
import {
  ConceptNode,
  ConceptEdge,
  ConceptGraphData,
  ObservationNode,
  ObservationEdge,
  ObservationGraphData,
  ProjectNode,
  ProjectEdge,
  ProjectGraphData,
  UsageStatsEntry,
  UsageStatsData
} from './graph-types.js';

interface ObservationRow {
  id: number;
  project: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  created_at_epoch: number;
  sdk_session_id: string;
}

export class GraphService {
  constructor(private sessionStore: SessionStore) {}

  /**
   * Build concept network graph showing concept co-occurrences
   */
  buildConceptNetwork(project?: string, limit: number = 100): ConceptGraphData {
    const db = this.sessionStore.db;

    // Get all observations with concepts
    let query = `
      SELECT id, project, type, title, concepts, created_at_epoch
      FROM observations
      WHERE concepts IS NOT NULL AND concepts != '[]'
    `;
    const params: any[] = [];

    if (project) {
      query += ' AND project = ?';
      params.push(project);
    }

    query += ' ORDER BY created_at_epoch DESC';

    const observations = db.prepare(query).all(...params) as ObservationRow[];

    // Build concept map: concept -> { count, projects, lastUsed, observationIds }
    const conceptMap = new Map<string, {
      count: number;
      projects: Set<string>;
      lastUsed: number;
      observationIds: number[];
    }>();

    // Build co-occurrence map: "concept1|concept2" -> { count, projects }
    const cooccurrenceMap = new Map<string, {
      count: number;
      projects: Set<string>;
    }>();

    for (const obs of observations) {
      let concepts: string[] = [];
      try {
        concepts = JSON.parse(obs.concepts || '[]');
      } catch {
        continue;
      }

      if (!Array.isArray(concepts) || concepts.length === 0) continue;

      // Update concept counts
      for (const concept of concepts) {
        const existing = conceptMap.get(concept);
        if (existing) {
          existing.count++;
          existing.projects.add(obs.project);
          existing.lastUsed = Math.max(existing.lastUsed, obs.created_at_epoch);
          existing.observationIds.push(obs.id);
        } else {
          conceptMap.set(concept, {
            count: 1,
            projects: new Set([obs.project]),
            lastUsed: obs.created_at_epoch,
            observationIds: [obs.id]
          });
        }
      }

      // Build co-occurrence edges
      for (let i = 0; i < concepts.length; i++) {
        for (let j = i + 1; j < concepts.length; j++) {
          const key = [concepts[i], concepts[j]].sort().join('|');
          const existing = cooccurrenceMap.get(key);
          if (existing) {
            existing.count++;
            existing.projects.add(obs.project);
          } else {
            cooccurrenceMap.set(key, {
              count: 1,
              projects: new Set([obs.project])
            });
          }
        }
      }
    }

    // Convert to nodes (sorted by count, limited)
    const sortedConcepts = Array.from(conceptMap.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, limit);

    const includedConcepts = new Set(sortedConcepts.map(([c]) => c));

    const nodes: ConceptNode[] = sortedConcepts.map(([concept, data]) => ({
      id: concept,
      label: concept,
      size: data.count,
      projects: Array.from(data.projects),
      lastUsed: data.lastUsed
    }));

    // Convert to edges (only between included concepts)
    const edges: ConceptEdge[] = [];
    for (const [key, data] of cooccurrenceMap) {
      const [source, target] = key.split('|');
      if (includedConcepts.has(source) && includedConcepts.has(target)) {
        edges.push({
          source,
          target,
          weight: data.count,
          projects: Array.from(data.projects)
        });
      }
    }

    // Find most connected concepts
    const connectionCounts = new Map<string, number>();
    for (const edge of edges) {
      connectionCounts.set(edge.source, (connectionCounts.get(edge.source) || 0) + 1);
      connectionCounts.set(edge.target, (connectionCounts.get(edge.target) || 0) + 1);
    }
    const mostConnected = Array.from(connectionCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([c]) => c);

    return {
      nodes,
      edges,
      stats: {
        totalConcepts: conceptMap.size,
        totalEdges: edges.length,
        mostConnected
      }
    };
  }

  /**
   * Build observation relationship graph
   */
  buildObservationGraph(project?: string, limit: number = 200): ObservationGraphData {
    const db = this.sessionStore.db;

    // Get observations with usage stats
    let query = `
      SELECT
        o.id,
        o.project,
        o.type,
        o.title,
        o.subtitle,
        o.concepts,
        o.files_read,
        o.files_modified,
        o.created_at_epoch,
        o.sdk_session_id,
        COALESCE(
          (SELECT COUNT(*) FROM observation_access WHERE observation_id = o.id),
          0
        ) as usage_count,
        (SELECT MAX(accessed_at_epoch) FROM observation_access WHERE observation_id = o.id) as last_accessed
      FROM observations o
      WHERE 1=1
    `;
    const params: any[] = [];

    if (project) {
      query += ' AND o.project = ?';
      params.push(project);
    }

    query += ' ORDER BY o.created_at_epoch DESC LIMIT ?';
    params.push(limit);

    const observations = db.prepare(query).all(...params) as Array<ObservationRow & {
      usage_count: number;
      last_accessed: number | null;
    }>;

    // Build nodes
    const nodes: ObservationNode[] = observations.map(obs => ({
      id: obs.id,
      title: obs.title || `Observation #${obs.id}`,
      type: obs.type,
      project: obs.project,
      usageCount: obs.usage_count,
      createdAt: obs.created_at_epoch,
      lastAccessed: obs.last_accessed
    }));

    // Build edges based on shared concepts, files, and sessions
    const edges: ObservationEdge[] = [];
    const obsIds = new Set(observations.map(o => o.id));

    // Index observations by concept, file, and session for efficient edge building
    const conceptIndex = new Map<string, number[]>();
    const fileIndex = new Map<string, number[]>();
    const sessionIndex = new Map<string, number[]>();

    for (const obs of observations) {
      // Index by concepts
      try {
        const concepts = JSON.parse(obs.concepts || '[]');
        for (const concept of concepts) {
          const existing = conceptIndex.get(concept) || [];
          existing.push(obs.id);
          conceptIndex.set(concept, existing);
        }
      } catch {}

      // Index by files
      try {
        const filesRead = JSON.parse(obs.files_read || '[]');
        const filesModified = JSON.parse(obs.files_modified || '[]');
        const allFiles = [...filesRead, ...filesModified];
        for (const file of allFiles) {
          const existing = fileIndex.get(file) || [];
          existing.push(obs.id);
          fileIndex.set(file, existing);
        }
      } catch {}

      // Index by session
      if (obs.sdk_session_id) {
        const existing = sessionIndex.get(obs.sdk_session_id) || [];
        existing.push(obs.id);
        sessionIndex.set(obs.sdk_session_id, existing);
      }
    }

    // Generate edges (avoid duplicates using Set)
    const edgeSet = new Set<string>();

    const addEdge = (source: number, target: number, relationship: ObservationEdge['relationship'], weight: number, detail?: string) => {
      if (source === target) return;
      const key = [Math.min(source, target), Math.max(source, target), relationship].join('|');
      if (edgeSet.has(key)) return;
      edgeSet.add(key);
      edges.push({ source, target, relationship, weight, detail });
    };

    // Shared concept edges
    for (const [concept, ids] of conceptIndex) {
      if (ids.length > 1 && ids.length <= 10) { // Limit highly connected concepts
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            addEdge(ids[i], ids[j], 'shared_concept', 1, concept);
          }
        }
      }
    }

    // Shared file edges
    for (const [file, ids] of fileIndex) {
      if (ids.length > 1 && ids.length <= 5) { // Limit highly connected files
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            addEdge(ids[i], ids[j], 'shared_file', 2, file);
          }
        }
      }
    }

    // Same session edges
    for (const [_, ids] of sessionIndex) {
      if (ids.length > 1) {
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            addEdge(ids[i], ids[j], 'same_session', 3);
          }
        }
      }
    }

    // Calculate stats
    const connectionCounts = new Map<number, number>();
    for (const edge of edges) {
      connectionCounts.set(edge.source, (connectionCounts.get(edge.source) || 0) + 1);
      connectionCounts.set(edge.target, (connectionCounts.get(edge.target) || 0) + 1);
    }

    const avgConnections = edges.length > 0
      ? edges.length * 2 / nodes.length
      : 0;

    return {
      nodes,
      edges,
      stats: {
        totalObservations: nodes.length,
        totalEdges: edges.length,
        avgConnections: Math.round(avgConnections * 100) / 100,
        clusters: sessionIndex.size
      }
    };
  }

  /**
   * Build project connection graph
   */
  buildProjectGraph(): ProjectGraphData {
    const db = this.sessionStore.db;

    // Get project statistics
    const projectStats = db.prepare(`
      SELECT
        project,
        COUNT(*) as observation_count,
        MAX(created_at_epoch) as last_activity
      FROM observations
      GROUP BY project
    `).all() as Array<{
      project: string;
      observation_count: number;
      last_activity: number;
    }>;

    // Get concept counts per project
    const observations = db.prepare(`
      SELECT project, concepts
      FROM observations
      WHERE concepts IS NOT NULL AND concepts != '[]'
    `).all() as Array<{ project: string; concepts: string }>;

    // Build project -> concepts mapping
    const projectConcepts = new Map<string, Set<string>>();
    const projectTypeCounts = new Map<string, Map<string, number>>();

    // Get type distribution per project
    const typeRows = db.prepare(`
      SELECT project, type, COUNT(*) as count
      FROM observations
      GROUP BY project, type
    `).all() as Array<{ project: string; type: string; count: number }>;

    for (const row of typeRows) {
      const existing = projectTypeCounts.get(row.project) || new Map<string, number>();
      existing.set(row.type, row.count);
      projectTypeCounts.set(row.project, existing);
    }

    for (const obs of observations) {
      try {
        const concepts = JSON.parse(obs.concepts || '[]');
        const existing = projectConcepts.get(obs.project) || new Set<string>();
        for (const concept of concepts) {
          existing.add(concept);
        }
        projectConcepts.set(obs.project, existing);
      } catch {}
    }

    // Build nodes
    const nodes: ProjectNode[] = projectStats.map(stat => {
      const concepts = projectConcepts.get(stat.project) || new Set();
      const typeCounts = projectTypeCounts.get(stat.project) || new Map();

      // Get top 3 types
      const topTypes = Array.from(typeCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([type, count]) => ({ type, count }));

      return {
        id: stat.project,
        observationCount: stat.observation_count,
        conceptCount: concepts.size,
        topTypes,
        lastActivity: stat.last_activity
      };
    });

    // Build edges based on shared concepts
    const edges: ProjectEdge[] = [];
    const projects = Array.from(projectConcepts.keys());

    for (let i = 0; i < projects.length; i++) {
      for (let j = i + 1; j < projects.length; j++) {
        const p1 = projects[i];
        const p2 = projects[j];
        const c1 = projectConcepts.get(p1) || new Set();
        const c2 = projectConcepts.get(p2) || new Set();

        // Find shared concepts
        const shared = Array.from(c1).filter(c => c2.has(c));

        if (shared.length > 0) {
          edges.push({
            source: p1,
            target: p2,
            sharedConcepts: shared,
            weight: shared.length
          });
        }
      }
    }

    // Find most connected projects
    const connectionCounts = new Map<string, number>();
    for (const edge of edges) {
      connectionCounts.set(edge.source, (connectionCounts.get(edge.source) || 0) + edge.weight);
      connectionCounts.set(edge.target, (connectionCounts.get(edge.target) || 0) + edge.weight);
    }
    const mostConnected = Array.from(connectionCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([p]) => p);

    return {
      nodes,
      edges,
      stats: {
        totalProjects: nodes.length,
        totalConnections: edges.length,
        mostConnected
      }
    };
  }

  /**
   * Get usage statistics for observations
   */
  getUsageStats(project?: string, limit: number = 50): UsageStatsData {
    const db = this.sessionStore.db;

    // Get most used observations with breakdown
    let query = `
      SELECT
        o.id,
        o.title,
        o.subtitle,
        o.type,
        o.project,
        o.created_at_epoch,
        COUNT(a.id) as usage_count,
        MAX(a.accessed_at) as last_accessed,
        SUM(CASE WHEN a.access_type = 'context_injection' THEN 1 ELSE 0 END) as context_injection_count,
        SUM(CASE WHEN a.access_type = 'search_result' THEN 1 ELSE 0 END) as search_result_count,
        SUM(CASE WHEN a.access_type = 'manual_view' THEN 1 ELSE 0 END) as manual_view_count
      FROM observations o
      LEFT JOIN observation_access a ON o.id = a.observation_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (project) {
      query += ' AND o.project = ?';
      params.push(project);
    }

    query += `
      GROUP BY o.id
      ORDER BY usage_count DESC, o.created_at_epoch DESC
      LIMIT ?
    `;
    params.push(limit);

    const rows = db.prepare(query).all(...params) as Array<{
      id: number;
      title: string | null;
      subtitle: string | null;
      type: string;
      project: string;
      created_at_epoch: number;
      usage_count: number;
      last_accessed: string | null;
      context_injection_count: number;
      search_result_count: number;
      manual_view_count: number;
    }>;

    const entries: UsageStatsEntry[] = rows.map(row => ({
      id: row.id,
      title: row.title || `Observation #${row.id}`,
      subtitle: row.subtitle,
      type: row.type,
      project: row.project,
      usageCount: row.usage_count,
      lastAccessed: row.last_accessed,
      createdAt: row.created_at_epoch,
      accessByType: {
        context_injection: row.context_injection_count || 0,
        search_result: row.search_result_count || 0,
        manual_view: row.manual_view_count || 0
      }
    }));

    // Calculate summary
    const totalAccesses = entries.reduce((sum, e) => sum + e.usageCount, 0);
    const totalObservationsAccessed = entries.filter(e => e.usageCount > 0).length;
    const avgAccessesPerObservation = totalObservationsAccessed > 0
      ? totalAccesses / totalObservationsAccessed
      : 0;

    // Find most common access type
    const typeTotals = {
      context_injection: entries.reduce((sum, e) => sum + e.accessByType.context_injection, 0),
      search_result: entries.reduce((sum, e) => sum + e.accessByType.search_result, 0),
      manual_view: entries.reduce((sum, e) => sum + e.accessByType.manual_view, 0)
    };
    const topAccessType = Object.entries(typeTotals)
      .sort((a, b) => b[1] - a[1])[0][0] as 'context_injection' | 'search_result' | 'manual_view';

    return {
      entries,
      summary: {
        totalAccesses,
        totalObservationsAccessed,
        avgAccessesPerObservation: Math.round(avgAccessesPerObservation * 100) / 100,
        topAccessType
      }
    };
  }
}
