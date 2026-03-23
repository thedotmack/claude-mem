import React from 'react';

interface MetadataFooterProps {
  id: number;
  date: string;
  node?: string | null;
  platform?: string | null;
  instance?: string | null;
  sessionId?: string;
}

/**
 * Return a CSS class for platform-specific coloring.
 */
function platformColorClass(platform: string): string {
  const p = platform.toLowerCase();
  if (p.includes('claude')) return 'badge-platform--claude';
  if (p.includes('cursor')) return 'badge-platform--cursor';
  return 'badge-platform--raw';
}

/**
 * Format epoch-based locale string to short form (DD/MM/YYYY HH:MM).
 * Strips seconds if present.
 */
function shortenDate(dateStr: string): string {
  // Remove seconds from time portion: "23/03/2026 23:12:51" → "23/03/2026 23:12"
  return dateStr.replace(/(\d{2}:\d{2}):\d{2}/, '$1');
}

/**
 * Shared metadata footer used by ObservationCard, SummaryCard, and PromptCard.
 * Renders a consistent row of badge chips for id, date, node, platform, and instance.
 */
export function MetadataFooter({ id, date, node, platform, instance }: MetadataFooterProps) {
  const displayInstance = instance || 'default';
  const instanceMuted = !instance;

  return (
    <div className="metadata-footer">
      <span className="metadata-badge metadata-badge--id">
        <span className="metadata-badge-icon">#</span>
        <span>{id}</span>
      </span>

      <span className="metadata-separator">&middot;</span>

      <span className="metadata-badge metadata-badge--date">
        <svg className="metadata-badge-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        <span>{shortenDate(date)}</span>
      </span>

      {node && (
        <>
          <span className="metadata-separator">&middot;</span>
          <span className="metadata-badge metadata-badge--node" title={node}>
            <svg className="metadata-badge-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
            <span>{node}</span>
          </span>
        </>
      )}

      {platform && (
        <>
          <span className="metadata-separator">&middot;</span>
          <span className={`metadata-badge metadata-badge--platform ${platformColorClass(platform)}`}>
            <svg className="metadata-badge-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            <span>{platform}</span>
          </span>
        </>
      )}

      <span className="metadata-separator">&middot;</span>
      <span className={`metadata-badge metadata-badge--instance ${instanceMuted ? 'metadata-badge--muted' : ''}`} title={`Instance: ${displayInstance}`}>
        <svg className="metadata-badge-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        </svg>
        <span>{displayInstance}</span>
      </span>
    </div>
  );
}
