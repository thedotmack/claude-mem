import React from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import {
  useGraph,
  GraphTab,
  UsageStatsData
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
  { id: 'usage', label: 'Usage', icon: '📊' }
];

export function GraphPanel({ project }: GraphPanelProps) {
  const {
    conceptData,
    observationData,
    projectData,
    usageData,
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
