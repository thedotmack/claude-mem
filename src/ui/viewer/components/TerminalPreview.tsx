import React, { useMemo, useRef, useLayoutEffect, useState } from 'react';
import AnsiToHtml from 'ansi-to-html';
import DOMPurify from 'dompurify';

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
  const preRef = useRef<HTMLPreElement>(null);
  const scrollTopRef = useRef(0);
  const [wordWrap, setWordWrap] = useState(true);

  const html = useMemo(() => {
    if (preRef.current) {
      scrollTopRef.current = preRef.current.scrollTop;
    }
    if (!content) return '';
    const convertedHtml = ansiConverter.toHtml(content);
    return DOMPurify.sanitize(convertedHtml, {
      ALLOWED_TAGS: ['span', 'div', 'br'],
      ALLOWED_ATTR: ['style', 'class'],
      ALLOW_DATA_ATTR: false
    });
  }, [content]);

  useLayoutEffect(() => {
    if (preRef.current && scrollTopRef.current > 0) {
      preRef.current.scrollTop = scrollTopRef.current;
    }
  }, [html]);

  const preStyle: React.CSSProperties = {
    padding: '16px',
    margin: 0,
    fontFamily: 'var(--font-terminal)',
    fontSize: '12px',
    lineHeight: '1.6',
    overflow: 'auto',
    color: 'var(--fg)',
    backgroundColor: 'var(--surface-sunken)',
    whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
    wordBreak: wordWrap ? 'break-word' : 'normal',
    position: 'absolute',
    inset: 0,
  };

  return (
    <div
      className={className}
      style={{
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        overflow: 'hidden',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 10px 40px rgba(0, 0, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.3)'
      }}
    >
      {/* Window chrome */}
      <div
        style={{
          padding: '12px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          gap: '6px',
          alignItems: 'center',
          backgroundColor: 'var(--surface)'
        }}
      >
        <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#ff5f57' }} />
        <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#ffbd2e' }} />
        <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#28c840' }} />

        <button
          onClick={() => setWordWrap(!wordWrap)}
          style={{
            marginLeft: 'auto',
            padding: '4px 8px',
            fontSize: '11px',
            fontWeight: 500,
            color: wordWrap ? 'var(--fg-2)' : 'var(--coral-500)',
            backgroundColor: 'transparent',
            border: '1px solid',
            borderColor: wordWrap ? 'var(--border)' : 'var(--coral-500)',
            borderRadius: '4px',
            cursor: 'pointer',
            transition: 'all 0.2s',
            whiteSpace: 'nowrap'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--coral-500)';
            e.currentTarget.style.color = 'var(--coral-500)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = wordWrap ? 'var(--border)' : 'var(--coral-500)';
            e.currentTarget.style.color = wordWrap ? 'var(--fg-2)' : 'var(--coral-500)';
          }}
          title={wordWrap ? 'Disable word wrap (scroll horizontally)' : 'Enable word wrap'}
        >
          {wordWrap ? '⤢ Wrap' : '⇄ Scroll'}
        </button>
      </div>

      {/* Content area */}
      {isLoading ? (
        <div
          style={{
            padding: '16px',
            fontFamily: 'var(--font-terminal)',
            fontSize: '12px',
            color: 'var(--fg-2)'
          }}
        >
          Loading preview...
        </div>
      ) : (
        <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
          <pre
            ref={preRef}
            style={preStyle}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )}
    </div>
  );
}
