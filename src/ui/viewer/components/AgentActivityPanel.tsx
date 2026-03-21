import React from 'react';
import { AgentActivityEvent, AgentErrorEvent } from '../types';

interface AgentActivityPanelProps {
  agentActivity: Record<number, AgentActivityEvent>;
  agentErrors: AgentErrorEvent[];
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; pulse?: boolean }> = {
  calling_api: { label: 'Calling API', color: '#facc15', bg: 'rgba(250,204,21,0.1)', pulse: true },
  processing_response: { label: 'Processing', color: '#60a5fa', bg: 'rgba(96,165,250,0.1)' },
  idle: { label: 'Idle', color: '#888', bg: 'rgba(136,136,136,0.1)' },
  error: { label: 'Error', color: '#f87171', bg: 'rgba(248,113,113,0.15)' },
};

export function AgentActivityPanel({ agentActivity, agentErrors }: AgentActivityPanelProps) {
  const sessions = Object.values(agentActivity).sort((a, b) => b.timestamp - a.timestamp);

  if (sessions.length === 0) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary, #888)' }}>
        No active model sessions. Activity will appear here when models start processing.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {sessions.map(session => {
        const cfg = STATUS_CONFIG[session.status] || STATUS_CONFIG.idle;
        const duration = Math.floor((Date.now() - session.timestamp) / 1000);
        const durationStr = duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`;
        const latestError = session.status === 'error'
          ? agentErrors.find(e => e.sessionDbId === session.sessionDbId)
          : null;

        return (
          <div key={session.sessionDbId} style={{
            background: cfg.bg,
            border: `1px solid ${cfg.color}33`,
            borderRadius: '8px',
            padding: '12px 16px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{
                  width: '8px', height: '8px', borderRadius: '50%',
                  background: cfg.color, display: 'inline-block',
                  animation: cfg.pulse ? 'pulse 1.5s ease-in-out infinite' : 'none'
                }} />
                <span style={{ fontWeight: 600, color: 'var(--text-primary, #e0e0e0)', fontSize: '14px' }}>
                  {session.provider}
                </span>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary, #888)', fontFamily: 'monospace' }}>
                  {session.model}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{
                  fontSize: '11px', padding: '2px 10px', borderRadius: '10px',
                  background: `${cfg.color}22`, color: cfg.color, fontWeight: 600
                }}>
                  {cfg.label}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary, #888)', fontFamily: 'monospace' }}>
                  {durationStr} ago
                </span>
              </div>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary, #888)', marginTop: '6px' }}>
              Project: {session.project} | Session: #{session.sessionDbId}
            </div>

            {/* Error details (expanded) */}
            {latestError && (
              <div style={{
                marginTop: '8px', padding: '8px 12px',
                background: 'rgba(248,113,113,0.08)',
                border: '1px solid rgba(248,113,113,0.2)',
                borderRadius: '6px', fontSize: '12px'
              }}>
                <div style={{ color: '#f87171', fontWeight: 600, marginBottom: '4px' }}>
                  {latestError.errorMessage}
                </div>
                {latestError.promptSnippet && (
                  <div style={{ color: 'var(--text-secondary, #666)', fontFamily: 'monospace', fontSize: '10px', marginTop: '4px' }}>
                    Prompt: {latestError.promptSnippet}...
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
