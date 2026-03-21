import React, { useMemo } from 'react';
import { Stats, Observation, CollabStatus } from '../types';

interface PerformanceMetricsProps {
  stats: Stats;
  observations: Observation[];
  status: CollabStatus | null;
}

function formatUptime(seconds?: number): string {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="metrics-card">
      <div className="metrics-card-label">{label}</div>
      <div className="metrics-card-value">{value}</div>
      {sub && <div className="metrics-card-sub">{sub}</div>}
    </div>
  );
}

function ActivityChart({ observations }: { observations: Observation[] }) {
  const days = useMemo(() => {
    const now = Date.now();
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const result: { label: string; count: number }[] = [];

    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(now - i * 86400000);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 86400000);

      const count = observations.filter(
        o => o.created_at_epoch >= dayStart.getTime() && o.created_at_epoch < dayEnd.getTime()
      ).length;

      result.push({
        label: i === 0 ? 'Today' : i === 1 ? 'Yesterday' : dayNames[dayStart.getDay()],
        count,
      });
    }
    return result;
  }, [observations]);

  const maxCount = Math.max(...days.map(d => d.count), 1);

  return (
    <div className="metrics-section">
      <h3 className="metrics-section-title">Activity (Last 7 Days)</h3>
      <div className="metrics-chart">
        {days.map((day, i) => (
          <div key={i} className="metrics-chart-row">
            <span className="metrics-chart-label">{day.label}</span>
            <div className="metrics-chart-bar-bg">
              <div
                className="metrics-chart-bar"
                style={{ width: `${(day.count / maxCount) * 100}%` }}
              />
            </div>
            <span className="metrics-chart-count">{day.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentActivity({ status }: { status: CollabStatus | null }) {
  if (!status?.controls?.agents) return null;

  const agents = Object.entries(status.controls.agents);

  return (
    <div className="metrics-section">
      <h3 className="metrics-section-title">Agent Activity</h3>
      {agents.map(([name, config]) => {
        const pendingCount = status.pending_tasks?.filter(
          (t: any) => t.metadata?.assignee === name
        ).length || 0;
        const unreadCount = status.unread_messages?.filter(
          m => m.to_agent === name && !m.read
        ).length || 0;
        const statusColor =
          config.status === 'online' || config.status === 'active'
            ? 'var(--color-accent-success)'
            : config.status === 'busy'
            ? 'var(--color-accent-summary)'
            : 'var(--color-text-muted)';

        return (
          <div key={name} className="metrics-agent-row">
            <div className="metrics-agent-info">
              <span className="metrics-agent-dot" style={{ backgroundColor: statusColor }} />
              <span className="metrics-agent-name">{name}</span>
              <span className="metrics-agent-model">{config.model}</span>
            </div>
            <div className="metrics-agent-stats">
              {pendingCount > 0 && (
                <span className="metrics-agent-badge">{pendingCount} tasks</span>
              )}
              {unreadCount > 0 && (
                <span className="metrics-agent-badge metrics-agent-badge-urgent">
                  {unreadCount} unread
                </span>
              )}
              {pendingCount === 0 && unreadCount === 0 && (
                <span className="metrics-agent-badge-idle">idle</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TypeBreakdown({ observations }: { observations: Observation[] }) {
  const types = useMemo(() => {
    const counts: Record<string, number> = {};
    observations.forEach(o => {
      const t = o.type || 'unknown';
      counts[t] = (counts[t] || 0) + 1;
    });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  }, [observations]);

  const maxCount = types.length > 0 ? types[0][1] : 1;

  return (
    <div className="metrics-section">
      <h3 className="metrics-section-title">Observation Types</h3>
      <div className="metrics-types">
        {types.map(([type, count]) => (
          <div key={type} className="metrics-type-row">
            <span className="metrics-type-label">{type}</span>
            <div className="metrics-type-bar-bg">
              <div
                className="metrics-type-bar"
                style={{ width: `${(count / maxCount) * 100}%` }}
              />
            </div>
            <span className="metrics-type-count">{count}</span>
          </div>
        ))}
        {types.length === 0 && (
          <div className="metrics-empty">No observations yet</div>
        )}
      </div>
    </div>
  );
}

export function PerformanceMetrics({ stats, observations, status }: PerformanceMetricsProps) {
  return (
    <div className="metrics-dashboard">
      {/* Key Metrics */}
      <div className="metrics-grid">
        <MetricCard
          label="Uptime"
          value={formatUptime(stats.worker?.uptime)}
          sub={stats.worker?.version ? `v${stats.worker.version}` : undefined}
        />
        <MetricCard
          label="Observations"
          value={String(stats.database?.observations ?? '—')}
          sub={`${stats.database?.sessions ?? 0} sessions`}
        />
        <MetricCard
          label="Database"
          value={formatBytes(stats.database?.size)}
          sub={`${stats.database?.summaries ?? 0} summaries`}
        />
        <MetricCard
          label="SSE Clients"
          value={String(stats.worker?.sseClients ?? 0)}
          sub={`${stats.worker?.activeSessions ?? 0} active sessions`}
        />
      </div>

      {/* Activity Chart */}
      <ActivityChart observations={observations} />

      {/* Bottom Row: Two Columns */}
      <div className="metrics-columns">
        <AgentActivity status={status} />
        <TypeBreakdown observations={observations} />
      </div>
    </div>
  );
}
