import React from 'react';
import { HealthData, TrackedClient } from '../types';

interface NetworkTopologyProps {
  mode: 'server' | 'client';
  health: HealthData;
  clients: TrackedClient[];
  authToken?: string;
}

function formatTimeAgo(isoString: string): string {
  const timestamp = new Date(isoString).getTime();
  if (Number.isNaN(timestamp)) return 'unknown';
  const diff = Math.max(0, Date.now() - timestamp);
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

          {/* Server identity + version */}
          <div className="topology-segment">
            <span className="topology-serving-label">Serving as</span>
            <span className="topology-node-name">{health.node || 'unknown'}</span>
            {health.version && (
              <span className="topology-version">
                v{health.version}{health.commit ? ` (${health.commit})` : ''}
              </span>
            )}
          </div>
        </div>

        {/* Connected nodes */}
        {clients.length > 0 && (
          <div className="topology-clients">
            {clients.map((client) => (
              <div
                key={client.node + '|' + client.instance}
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
        {/* Local node identity + proxy version */}
        {health.node && (
          <div className="topology-segment">
            <span className="topology-serving-label">Running as</span>
            <span className="topology-node-name">{health.node}</span>
            {health.proxyVersion && (
              <span className="topology-version">
                v{health.proxyVersion}{health.proxyCommit ? ` (${health.proxyCommit})` : ''}
              </span>
            )}
          </div>
        )}

        {/* Connection target + server version */}
        <div className="topology-segment">
          <span className="topology-arrow">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </span>
          <span className="topology-connect-label">Connected to</span>
          <span className="topology-node-name">{health.serverHost || 'unknown'}</span>
          {health.serverVersion && (
            <span className={`topology-version ${health.versionMatch === false ? 'topology-version--mismatch' : ''}`}>
              v{health.serverVersion}{health.serverCommit ? ` (${health.serverCommit})` : ''}
            </span>
          )}
        </div>

        {/* Version mismatch warning */}
        {health.versionMatch === false && (
          <div className="topology-segment">
            <span className="topology-buffer-warning">
              ⚠ Version mismatch — proxy v{health.proxyVersion} ≠ server v{health.serverVersion}
            </span>
          </div>
        )}

        {/* Reachable indicator */}
        <div className="topology-segment">
          <span className={`topology-reachable-dot ${health.serverReachable ? 'reachable' : 'unreachable'}`} />
          <span className="topology-reachable-text">
            {health.serverReachable ? 'Server reachable' : 'Server unreachable'}
          </span>
        </div>

        {/* Buffer status */}
        {(health.pendingBuffer ?? 0) > 0 && (
          <div className="topology-segment">
            <span className="topology-buffer-warning">⚠ Buffer: {health.pendingBuffer} pending</span>
          </div>
        )}
      </div>
    </div>
  );
}
