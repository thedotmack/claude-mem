import React from 'react';

interface TerminalPreviewProps {
  content: string;
  isLoading?: boolean;
  className?: string;
}

export function TerminalPreview({ content, isLoading = false, className = '' }: TerminalPreviewProps) {
  return (
    <div
      className={className}
      style={{
        backgroundColor: 'var(--color-bg-card)',
        border: '1px solid var(--color-border-primary)',
        borderRadius: '8px',
        overflow: 'hidden',
        height: '100%',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {/* Window chrome */}
      <div
        style={{
          padding: '12px',
          borderBottom: '1px solid var(--color-border-primary)',
          display: 'flex',
          gap: '6px',
          backgroundColor: 'var(--color-bg-header)'
        }}
      >
        <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#ff5f57' }} />
        <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#ffbd2e' }} />
        <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#28c840' }} />
      </div>

      {/* Content area */}
      {isLoading ? (
        <div
          style={{
            padding: '16px',
            fontFamily: 'Monaspace Radon, monospace',
            fontSize: '12px',
            color: 'var(--color-text-secondary)'
          }}
        >
          Loading preview...
        </div>
      ) : (
        <pre
          style={{
            padding: '16px',
            margin: 0,
            fontFamily: 'Monaspace Radon, monospace',
            fontSize: '12px',
            lineHeight: '1.6',
            overflow: 'auto',
            flex: 1,
            color: 'var(--color-text-primary)',
            backgroundColor: 'var(--color-bg-card)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {content}
        </pre>
      )}
    </div>
  );
}
