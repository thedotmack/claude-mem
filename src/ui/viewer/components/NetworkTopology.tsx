import React from 'react';
import { HealthData, TrackedClient } from '../types';

interface NetworkTopologyProps {
  mode: 'server' | 'client';
  health: HealthData;
  clients: TrackedClient[];
  authToken?: string;
}

function formatTimeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function maskToken(token: string): string {
  if (!token) return 'not set';
  if (token.length <= 4) return token.replace(/./g, '\u2022');
  return token.slice(0, 4) + '\u2022'.repeat(8);
}


export function NetworkTopology({ mode, health, clients, authToken }: NetworkTopologyProps) {
  if (mode === 'server') {
    const activeCount = clients.filter(c => c.active).length;

    return (
      <div className="topology-bar">
        <div className="topology-row">
          {/* Security status */}
          <div className="topology-segment">
            <span className="topology-lock-icon">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </span>
            <span className="topology-security-badge">
              Secured
            </span>
            <span className="topology-token">{maskToken(authToken || '')}</span>
          </div>

          {/* Server identity */}
          <div className="topology-segment">
            <span className="topology-serving-label">Serving as</span>
            <span className="topology-node-name">{health.node || 'unknown'}</span>
          </div>
        </div>

        {/* Connected nodes */}
        {clients.length > 0 && (
          <div className="topology-clients">
            {clients.map((client) => (
              <div
                key={client.node}
                className={`topology-client-chip ${client.active ? '' : 'topology-client-chip--inactive'}`}
              >
                <span className={`topology-client-dot ${client.active ? 'topology-client-dot--active' : 'topology-client-dot--inactive'}`} />
                <span className="topology-client-name">{client.node}</span>
                <span className="topology-client-stats">
                  {client.requestCount} req{client.requestCount !== 1 ? 's' : ''}
                </span>
                <span className="topology-client-time">{formatTimeAgo(client.lastSeen)}</span>
              </div>
            ))}
          </div>
        )}

        {clients.length === 0 && (
          <div className="topology-empty">No client nodes connected recently</div>
        )}
      </div>
    );
  }

  // Client mode
  return (
    <div className="topology-bar">
      <div className="topology-row">
        {/* Connection target */}
        <div className="topology-segment">
          <span className="topology-arrow">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </span>
          <span className="topology-connect-label">Connected to</span>
          <span className="topology-node-name">{health.node || 'unknown'}</span>
        </div>

        {/* Reachable indicator */}
        <div className="topology-segment">
          <span className={`topology-reachable-dot ${health.status === 'ok' ? 'reachable' : 'unreachable'}`} />
          <span className="topology-reachable-text">
            {health.status === 'ok' ? 'Server reachable' : 'Server unreachable'}
          </span>
        </div>
      </div>
    </div>
  );
}
