import React, { useMemo } from 'react';
import AnsiToHtml from 'ansi-to-html';

interface TerminalPreviewProps {
  content: string;
  isLoading?: boolean;
  className?: string;
}

const ansiConverter = new AnsiToHtml({
  fg: '#dcd6cc',
  bg: '#252320',
  newline: false,
  escapeXML: true,
  stream: false
});

export function TerminalPreview({ content, isLoading = false, className = '' }: TerminalPreviewProps) {
  const html = useMemo(() => {
    if (!content) return '';
    return ansiConverter.toHtml(content);
  }, [content]);

  const preStyle: React.CSSProperties = {
    padding: '16px',
    margin: 0,
    fontFamily: 'var(--font-terminal)',
    fontSize: '12px',
    lineHeight: '1.6',
    overflow: 'auto',
    color: 'var(--color-text-primary)',
    backgroundColor: 'var(--color-bg-card)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    position: 'absolute',
    inset: 0,
  };

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
            fontFamily: 'var(--font-terminal)',
            fontSize: '12px',
            color: 'var(--color-text-secondary)'
          }}
        >
          Loading preview...
        </div>
      ) : (
        <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
          <pre
            style={preStyle}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )}
    </div>
  );
}
