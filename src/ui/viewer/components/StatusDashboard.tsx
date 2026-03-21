import React, { useState, useEffect } from 'react';
import { CollabStatus, AgentMessage, FileLock } from '../types';
import { TeamPanel } from './TeamPanel';
import { DelegationView } from './DelegationView';

interface StatusDashboardProps {
  status: CollabStatus | null;
  messages: AgentMessage[];
  isLoading: boolean;
  error: string | null;
  onRefresh?: () => void;
}

function AgentCard({ name, config, isLeader, hasActiveLocks }: { name: string; config: any; isLeader: boolean; hasActiveLocks: boolean }) {
  const effectiveStatus = config.status === 'online' || config.status === 'busy' || config.status === 'active'
    ? config.status
    : hasActiveLocks ? 'active' : (config.status || 'offline');
  const statusColor = effectiveStatus === 'online' ? 'var(--color-accent-success)' :
    effectiveStatus === 'active' ? 'var(--color-accent-success)' :
    effectiveStatus === 'busy' ? 'var(--color-accent-summary)' : 'var(--color-text-muted)';

  return (
    <div className="collab-agent-card">
      <div className="collab-agent-header">
        <span className="collab-agent-name">{name}</span>
        {isLeader && <span className="collab-badge collab-badge-leader">LEADER</span>}
        <span className="collab-agent-status" style={{ color: statusColor }}>
          {effectiveStatus}
        </span>
      </div>
      <div className="collab-agent-details">
        <span className="collab-agent-detail">Model: {config.model}</span>
        <span className="collab-agent-detail">Permissions: {config.permissions}</span>
        <span className="collab-agent-detail">Listening: {config.listening ? 'Yes' : 'No'}</span>
      </div>
    </div>
  );
}

function LockRow({ lock }: { lock: FileLock }) {
  const remaining = Math.max(0, Math.round((lock.expires_at_epoch - Date.now()) / 1000));
  return (
    <div className="collab-lock-row">
      <span className="collab-lock-path">{lock.file_path}</span>
      <span className="collab-lock-agent">{lock.locked_by}</span>
      <span className="collab-lock-expires">{remaining}s remaining</span>
    </div>
  );
}

function MessageRow({ msg }: { msg: AgentMessage }) {
  const time = new Date(msg.created_at_epoch).toLocaleTimeString();
  return (
    <div className={`collab-message-row ${msg.urgent ? 'collab-message-urgent' : ''} ${msg.read ? 'collab-message-read' : ''}`}>
      <div className="collab-message-header">
        <span className="collab-message-from">{msg.from_agent}</span>
        <span className="collab-message-arrow">&rarr;</span>
        <span className="collab-message-to">{msg.to_agent}</span>
        {msg.urgent === 1 && <span className="collab-badge collab-badge-urgent">URGENT</span>}
        <span className="collab-message-time">{time}</span>
      </div>
      <div className="collab-message-subject">{msg.subject}</div>
      {msg.body && <div className="collab-message-body">{msg.body}</div>}
    </div>
  );
}

interface WorkerStats {
  worker: { version: string; uptime: number; activeSessions: number; sseClients: number; port: number };
  database: { path: string; size: number; observations: number; sessions: number; summaries: number };
}

interface DoctorInfo {
  supervisor: { running: boolean; pid: number; uptime: string };
  processes: Array<{ id: string; pid: number; type: string; status: string; startedAt: string }>;
  health: { deadProcessPids: number[]; envClean: boolean };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function PerformanceMetrics() {
  const [stats, setStats] = useState<WorkerStats | null>(null);
  const [doctor, setDoctor] = useState<DoctorInfo | null>(null);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const [statsRes, doctorRes] = await Promise.all([
          fetch('/api/stats').then(r => r.ok ? r.json() : null),
          fetch('/api/admin/doctor').then(r => r.ok ? r.json() : null)
        ]);
        if (statsRes) setStats(statsRes as WorkerStats);
        if (doctorRes) setDoctor(doctorRes as DoctorInfo);
      } catch { /* ignore */ }
    };
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 10000);
    return () => clearInterval(interval);
  }, []);

  if (!stats) return null;

  return (
    <div className="collab-section">
      <h2 className="collab-section-title">Performance Metrics</h2>
      <div className="collab-stats-grid">
        <div className="collab-stat-card">
          <div className="collab-stat-value">{formatUptime(stats.worker.uptime)}</div>
          <div className="collab-stat-label">Worker Uptime</div>
        </div>
        <div className="collab-stat-card">
          <div className="collab-stat-value">v{stats.worker.version}</div>
          <div className="collab-stat-label">Version</div>
        </div>
        <div className="collab-stat-card">
          <div className="collab-stat-value">{stats.worker.port}</div>
          <div className="collab-stat-label">Port</div>
        </div>
        <div className="collab-stat-card">
          <div className="collab-stat-value">{stats.worker.activeSessions}</div>
          <div className="collab-stat-label">Active Sessions</div>
        </div>
        <div className="collab-stat-card">
          <div className="collab-stat-value">{stats.worker.sseClients}</div>
          <div className="collab-stat-label">SSE Clients</div>
        </div>
        <div className="collab-stat-card">
          <div className="collab-stat-value">{formatBytes(stats.database.size)}</div>
          <div className="collab-stat-label">Database Size</div>
        </div>
        <div className="collab-stat-card">
          <div className="collab-stat-value">{stats.database.observations}</div>
          <div className="collab-stat-label">Observations</div>
        </div>
        <div className="collab-stat-card">
          <div className="collab-stat-value">{stats.database.sessions}</div>
          <div className="collab-stat-label">Sessions</div>
        </div>
      </div>

      {/* Process Health */}
      {doctor && (
        <div style={{ marginTop: '12px' }}>
          <div className="collab-section-title" style={{ fontSize: '13px', marginBottom: '8px' }}>
            Process Health
            {doctor.health.deadProcessPids.length === 0
              ? <span style={{ color: 'var(--color-accent-success)', marginLeft: '8px', fontSize: '11px' }}>ALL HEALTHY</span>
              : <span style={{ color: 'var(--color-accent-error)', marginLeft: '8px', fontSize: '11px' }}>{doctor.health.deadProcessPids.length} DEAD</span>
            }
          </div>
          <div className="collab-locks-list">
            {doctor.processes.map(proc => (
              <div key={proc.id} className="collab-lock-row">
                <span className="collab-lock-path">{proc.id}</span>
                <span className="collab-lock-agent">PID {proc.pid}</span>
                <span className="collab-lock-expires" style={{
                  color: proc.status === 'alive' ? 'var(--color-accent-success)' : 'var(--color-accent-error)'
                }}>
                  {proc.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function StatusDashboard({ status, messages, isLoading, error, onRefresh }: StatusDashboardProps) {
  if (isLoading && !status) {
    return <div className="collab-loading">Loading collaboration status...</div>;
  }

  if (error) {
    return <div className="collab-error">Error: {error}</div>;
  }

  if (!status) return null;

  const { controls, locks, unread_messages } = status;

  return (
    <div className="collab-dashboard">
      {/* Team Management */}
      <div className="collab-section">
        <TeamPanel controls={controls} onRefresh={onRefresh || (() => {})} />
      </div>

      {/* Task Delegation */}
      <div className="collab-section">
        <DelegationView
          controls={controls}
          pendingTasks={status?.pending_tasks || []}
          onRefresh={onRefresh || (() => {})}
        />
      </div>

      {/* Active Locks Section */}
      <div className="collab-section">
        <h2 className="collab-section-title">
          File Locks
          <span className="collab-count">{locks.length}</span>
        </h2>
        {locks.length === 0 ? (
          <div className="collab-empty">No active file locks</div>
        ) : (
          <div className="collab-locks-list">
            {locks.map(lock => <LockRow key={lock.id} lock={lock} />)}
          </div>
        )}
      </div>

      {/* Messages Section */}
      <div className="collab-section">
        <h2 className="collab-section-title">
          Recent Messages
          <span className="collab-count">{messages.length}</span>
        </h2>
        {messages.length === 0 ? (
          <div className="collab-empty">No messages</div>
        ) : (
          <div className="collab-messages-list">
            {messages.slice(0, 20).map(msg => <MessageRow key={msg.id} msg={msg} />)}
          </div>
        )}
      </div>

      {/* Quick Stats */}
      <div className="collab-section">
        <h2 className="collab-section-title">Quick Stats</h2>
        <div className="collab-stats-grid">
          <div className="collab-stat-card">
            <div className="collab-stat-value">{controls.leader}</div>
            <div className="collab-stat-label">Current Leader</div>
          </div>
          <div className="collab-stat-card">
            <div className="collab-stat-value">{controls.leader_mode}</div>
            <div className="collab-stat-label">Leader Mode</div>
          </div>
          <div className="collab-stat-card">
            <div className="collab-stat-value">{unread_messages.length}</div>
            <div className="collab-stat-label">Unread Messages</div>
          </div>
          <div className="collab-stat-card">
            <div className="collab-stat-value">{locks.length}</div>
            <div className="collab-stat-label">Active Locks</div>
          </div>
        </div>
      </div>

      {/* Performance Metrics */}
      <PerformanceMetrics />
    </div>
  );
}
