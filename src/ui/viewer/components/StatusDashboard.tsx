import React from 'react';
import { CollabStatus, AgentMessage, FileLock } from '../types';

interface StatusDashboardProps {
  status: CollabStatus | null;
  messages: AgentMessage[];
  isLoading: boolean;
  error: string | null;
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

export function StatusDashboard({ status, messages, isLoading, error }: StatusDashboardProps) {
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
      {/* Agents Section */}
      <div className="collab-section">
        <h2 className="collab-section-title">Agents</h2>
        <div className="collab-agents-grid">
          {Object.entries(controls.agents).map(([name, config]) => (
            <AgentCard
              key={name}
              name={name}
              config={config}
              isLeader={controls.leader === name}
              hasActiveLocks={locks.some(l => l.locked_by === name)}
            />
          ))}
        </div>
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
    </div>
  );
}
