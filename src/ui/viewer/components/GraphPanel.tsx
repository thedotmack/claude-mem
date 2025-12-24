import React from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import {
  useGraph,
  GraphTab,
  UsageStatsData,
  HealthData,
  InsightsData
} from '../hooks/useGraph';
import { ConceptGraph } from './graphs/ConceptGraph';
import { ObservationGraph } from './graphs/ObservationGraph';
import { ProjectGraph } from './graphs/ProjectGraph';

interface GraphPanelProps {
  project?: string;
}

const TAB_CONFIG: { id: GraphTab; label: string; icon: string }[] = [
  { id: 'concepts', label: 'Concepts', icon: '🏷️' },
  { id: 'observations', label: 'Observations', icon: '📝' },
  { id: 'projects', label: 'Projects', icon: '📁' },
  { id: 'usage', label: 'Usage', icon: '📊' },
  { id: 'insights', label: 'Insights', icon: '💡' },
  { id: 'health', label: 'Health', icon: '🩺' }
];

export function GraphPanel({ project }: GraphPanelProps) {
  const {
    conceptData,
    observationData,
    projectData,
    usageData,
    insightsData,
    healthData,
    isLoading,
    error,
    activeTab,
    setActiveTab,
    refresh
  } = useGraph(project);

  return (
    <div className="graph-view">
      {/* Tab Bar with Refresh */}
      <div className="graph-view-header">
        <div className="graph-view-tabs">
          {TAB_CONFIG.map(tab => (
            <button
              key={tab.id}
              className={`graph-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="tab-icon">{tab.icon}</span>
              <span className="tab-label">{tab.label}</span>
            </button>
          ))}
        </div>
        <button className="refresh-btn" onClick={refresh} disabled={isLoading} title="Refresh">
          <svg className={isLoading ? 'spinning' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {/* Content Area - Full Height */}
      <div className="graph-view-content">
        {error && (
          <div className="graph-error">
            <span className="error-icon">⚠️</span>
            <span>{error}</span>
          </div>
        )}

        {isLoading && !error && (
          <div className="graph-loading">
            <div className="spinner"></div>
            <span>Loading...</span>
          </div>
        )}

        {!isLoading && !error && (
          <ReactFlowProvider>
            {activeTab === 'concepts' && conceptData && (
              <ConceptGraph data={conceptData} />
            )}
            {activeTab === 'observations' && observationData && (
              <ObservationGraph data={observationData} />
            )}
            {activeTab === 'projects' && projectData && (
              <ProjectGraph data={projectData} />
            )}
            {activeTab === 'usage' && <UsageView data={usageData} />}
            {activeTab === 'insights' && <InsightsView data={insightsData} />}
            {activeTab === 'health' && <HealthView data={healthData} />}

            {/* Empty states */}
            {activeTab === 'concepts' && !conceptData && (
              <div className="graph-empty">No concept data available</div>
            )}
            {activeTab === 'observations' && !observationData && (
              <div className="graph-empty">No observation data available</div>
            )}
            {activeTab === 'projects' && !projectData && (
              <div className="graph-empty">No project data available</div>
            )}
          </ReactFlowProvider>
        )}
      </div>
    </div>
  );
}

function UsageView({ data }: { data: UsageStatsData | null }) {
  if (!data) return <div className="graph-empty">No usage data available</div>;

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleDateString();
  };

  return (
    <div className="graph-placeholder usage-view">
      <div className="stats-summary">
        <div className="stat-item">
          <span className="stat-value">{data.summary.totalAccesses}</span>
          <span className="stat-label">Total Accesses</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">{data.summary.totalObservationsAccessed}</span>
          <span className="stat-label">Observations Used</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">{data.summary.avgAccessesPerObservation.toFixed(1)}</span>
          <span className="stat-label">Avg per Obs</span>
        </div>
      </div>
      <div className="usage-table-container">
        <table className="usage-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Type</th>
              <th>Uses</th>
              <th>Last</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map(entry => (
              <tr key={entry.id}>
                <td className="title-cell" title={entry.title}>{entry.title}</td>
                <td className={`type-cell type-${entry.type}`}>{entry.type}</td>
                <td className="count-cell">{entry.usageCount}</td>
                <td className="date-cell">{formatDate(entry.lastAccessed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.entries.length === 0 && (
        <div className="no-usage">
          <p>No memory access recorded yet.</p>
          <p className="hint">Usage is tracked when observations are:</p>
          <ul>
            <li>Injected as context at session start</li>
            <li>Returned in search results</li>
          </ul>
        </div>
      )}
    </div>
  );
}

function InsightsView({ data }: { data: InsightsData | null }) {
  if (!data) return <div className="graph-empty">No insights data available</div>;

  const { crossProjectPatterns, projectSynergies, problemClusters, summary } = data;

  const getPatternTypeColor = (type: string) => {
    switch (type) {
      case 'shared_concept': return 'var(--color-accent-primary, #3b82f6)';
      case 'problem_solution': return 'var(--color-warning, #f59e0b)';
      case 'common_approach': return 'var(--color-success, #22c55e)';
      case 'tech_stack': return 'var(--color-accent-secondary, #8b5cf6)';
      default: return 'var(--color-text-secondary)';
    }
  };

  const formatPatternType = (type: string) => {
    return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  };

  return (
    <div className="graph-placeholder insights-view">
      {/* Summary Stats */}
      <div className="insights-summary">
        <div className="stat-item">
          <span className="stat-value">{summary.totalPatterns}</span>
          <span className="stat-label">Cross-Project Patterns</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">{summary.totalSynergies}</span>
          <span className="stat-label">Project Synergies</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">{summary.totalClusters}</span>
          <span className="stat-label">Problem Clusters</span>
        </div>
      </div>

      {/* Top Shared Concepts */}
      {summary.topSharedConcepts.length > 0 && (
        <div className="insights-section">
          <h4>Top Shared Concepts</h4>
          <div className="concept-tags">
            {summary.topSharedConcepts.map(concept => (
              <span key={concept} className="concept-tag">{concept}</span>
            ))}
          </div>
        </div>
      )}

      {/* Cross-Project Patterns */}
      {crossProjectPatterns.length > 0 && (
        <div className="insights-section">
          <h4>Cross-Project Patterns</h4>
          <div className="patterns-list">
            {crossProjectPatterns.slice(0, 10).map(pattern => (
              <div key={pattern.id} className="pattern-item">
                <div className="pattern-header">
                  <span className="pattern-name">{pattern.id}</span>
                  <span
                    className="pattern-type"
                    style={{ background: getPatternTypeColor(pattern.patternType) }}
                  >
                    {formatPatternType(pattern.patternType)}
                  </span>
                </div>
                <div className="pattern-details">
                  <span className="pattern-projects">
                    {pattern.projects.join(', ')}
                  </span>
                  <span className="pattern-count">
                    {pattern.observationCount} observations
                  </span>
                </div>
                <div className="pattern-strength">
                  <div
                    className="strength-bar"
                    style={{ width: `${pattern.strength * 100}%` }}
                  ></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Project Synergies */}
      {projectSynergies.length > 0 && (
        <div className="insights-section">
          <h4>Project Synergies</h4>
          <div className="synergies-list">
            {projectSynergies.slice(0, 5).map((synergy, idx) => (
              <div key={idx} className="synergy-item">
                <div className="synergy-projects">
                  <span className="project-name">{synergy.project1}</span>
                  <span className="synergy-arrow">↔</span>
                  <span className="project-name">{synergy.project2}</span>
                </div>
                <div className="synergy-details">
                  <span className="shared-count">
                    {synergy.sharedPatterns.length} shared patterns
                  </span>
                  <span className="synergy-score">
                    Score: {(synergy.synergyScore * 100).toFixed(0)}%
                  </span>
                </div>
                {synergy.potentialLearnings.length > 0 && (
                  <div className="potential-learnings">
                    <span className="learnings-label">Potential learnings:</span>
                    <span className="learnings-list">
                      {synergy.potentialLearnings.slice(0, 3).join(', ')}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Problem-Solution Clusters */}
      {problemClusters.length > 0 && (
        <div className="insights-section">
          <h4>Problem-Solution Clusters</h4>
          <div className="clusters-list">
            {problemClusters.map(cluster => (
              <div key={cluster.id} className="cluster-item">
                <div className="cluster-header">
                  <span className="cluster-type">{cluster.problemType}</span>
                  <span className="cluster-count">
                    {cluster.observations.length} observations
                  </span>
                </div>
                <div className="cluster-projects">
                  {cluster.projectsInvolved.join(', ')}
                </div>
                {cluster.commonApproaches.length > 0 && (
                  <div className="common-approaches">
                    Common approaches: {cluster.commonApproaches.join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {crossProjectPatterns.length === 0 && projectSynergies.length === 0 && (
        <div className="no-insights">
          <p>No cross-project patterns detected yet.</p>
          <p className="hint">Insights are generated when:</p>
          <ul>
            <li>Multiple projects share similar concepts</li>
            <li>Problem-solution patterns emerge across projects</li>
            <li>Common technical approaches are used</li>
          </ul>
        </div>
      )}
    </div>
  );
}

function HealthView({ data }: { data: HealthData | null }) {
  if (!data) return <div className="graph-empty">No health data available</div>;

  const { summary, recentLogs } = data;

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleTimeString();
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'healthy': return 'var(--color-success, #22c55e)';
      case 'warning': return 'var(--color-warning, #f59e0b)';
      case 'critical': return 'var(--color-error, #ef4444)';
      default: return 'var(--color-text-secondary)';
    }
  };

  const getLogLevelColor = (level: string) => {
    switch (level) {
      case 'ERROR': return 'var(--color-error, #ef4444)';
      case 'WARN': return 'var(--color-warning, #f59e0b)';
      case 'INFO': return 'var(--color-accent-primary, #3b82f6)';
      case 'DEBUG': return 'var(--color-text-secondary)';
      default: return 'var(--color-text-secondary)';
    }
  };

  return (
    <div className="graph-placeholder health-view">
      {/* Health Summary */}
      <div className="health-summary">
        <div className="health-status" style={{ borderColor: getStatusColor(summary.status) }}>
          <span className="status-indicator" style={{ background: getStatusColor(summary.status) }}></span>
          <span className="status-text">{summary.status.toUpperCase()}</span>
        </div>
        <div className="stats-row">
          <div className="stat-item">
            <span className="stat-value">{summary.totalLogs}</span>
            <span className="stat-label">Total Logs</span>
          </div>
          <div className="stat-item">
            <span className="stat-value" style={{ color: summary.errorCount24h > 0 ? 'var(--color-error)' : 'inherit' }}>
              {summary.errorCount24h}
            </span>
            <span className="stat-label">Errors (24h)</span>
          </div>
          <div className="stat-item">
            <span className="stat-value" style={{ color: summary.warnCount24h > 0 ? 'var(--color-warning)' : 'inherit' }}>
              {summary.warnCount24h}
            </span>
            <span className="stat-label">Warnings (24h)</span>
          </div>
          <div className="stat-item">
            <span className="stat-value">{summary.unresolvedPatterns}</span>
            <span className="stat-label">Unresolved Patterns</span>
          </div>
        </div>
      </div>

      {/* Top Errors */}
      {summary.topErrors.length > 0 && (
        <div className="top-errors">
          <h4>Top Error Patterns</h4>
          <div className="error-list">
            {summary.topErrors.map((err, idx) => (
              <div key={idx} className="error-item">
                <span className="error-count">{err.count}x</span>
                <span className="error-component">[{err.component}]</span>
                <span className="error-message" title={err.message}>
                  {err.message.length > 60 ? err.message.substring(0, 60) + '...' : err.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Logs */}
      <div className="recent-logs">
        <h4>Recent Logs</h4>
        <div className="logs-table-container">
          <table className="logs-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Level</th>
                <th>Component</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {recentLogs.map(log => (
                <tr key={log.id} className={`log-level-${log.level.toLowerCase()}`}>
                  <td className="time-cell">{formatTime(log.created_at)}</td>
                  <td className="level-cell" style={{ color: getLogLevelColor(log.level) }}>{log.level}</td>
                  <td className="component-cell">{log.component}</td>
                  <td className="message-cell" title={log.message}>
                    {log.message.length > 80 ? log.message.substring(0, 80) + '...' : log.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {recentLogs.length === 0 && (
        <div className="no-logs">
          <p>No logs recorded yet.</p>
          <p className="hint">Logs are captured automatically as the worker processes requests.</p>
        </div>
      )}
    </div>
  );
}
