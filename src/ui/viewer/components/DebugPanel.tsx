import React from 'react';
import { AgentErrorEvent } from '../types';

interface DebugPanelProps {
  errors: AgentErrorEvent[];
  onClear: () => void;
}

export function DebugPanel({ errors, onClear }: DebugPanelProps) {
  if (errors.length === 0) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary, #888)' }}>
        No errors. API call failures and exceptions will appear here with full context.
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <span style={{ fontSize: '13px', color: '#f87171', fontWeight: 600 }}>
          {errors.length} error{errors.length !== 1 ? 's' : ''}
        </span>
        <button onClick={onClear} style={{
          background: 'transparent', color: 'var(--text-secondary, #888)',
          border: '1px solid var(--border-color, #444)', borderRadius: '4px',
          padding: '4px 12px', fontSize: '11px', cursor: 'pointer'
        }}>
          Clear All
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {errors.map((error, i) => (
          <div key={`${error.sessionDbId}-${error.timestamp}-${i}`} style={{
            background: 'rgba(248,113,113,0.05)',
            border: '1px solid rgba(248,113,113,0.2)',
            borderRadius: '8px',
            padding: '12px 16px'
          }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: '#f87171', fontWeight: 600, fontSize: '13px' }}>
                  {error.provider}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary, #888)', fontFamily: 'monospace' }}>
                  {error.model}
                </span>
              </div>
              <span style={{ fontSize: '10px', color: 'var(--text-secondary, #666)' }}>
                {new Date(error.timestamp).toLocaleTimeString()}
              </span>
            </div>

            {/* Error message */}
            <div style={{
              color: '#fca5a5', fontSize: '12px', lineHeight: '1.5',
              padding: '8px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px',
              fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all'
            }}>
              {error.errorMessage}
            </div>

            {/* Context */}
            <div style={{ display: 'flex', gap: '12px', marginTop: '8px', fontSize: '10px', color: 'var(--text-secondary, #666)' }}>
              <span>Project: {error.project}</span>
              <span>Session: #{error.sessionDbId}</span>
              {error.errorCode && <span>Code: {error.errorCode}</span>}
            </div>

            {/* Prompt snippet */}
            {error.promptSnippet && (
              <details style={{ marginTop: '6px' }}>
                <summary style={{ fontSize: '10px', color: 'var(--text-secondary, #666)', cursor: 'pointer' }}>
                  Show prompt snippet
                </summary>
                <div style={{
                  marginTop: '4px', padding: '6px 8px',
                  background: 'rgba(0,0,0,0.15)', borderRadius: '4px',
                  fontSize: '10px', color: 'var(--text-secondary, #999)',
                  fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxHeight: '100px', overflowY: 'auto'
                }}>
                  {error.promptSnippet}
                </div>
              </details>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
