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
 * Return a CSS class for platform-specific pill coloring.
 */
function platformPillClass(platform: string): string {
  const p = platform.toLowerCase();
  if (p.includes('claude')) return 'pill--platform-claude';
  if (p.includes('cursor')) return 'pill--platform-cursor';
  return 'pill--platform-raw';
}

/**
 * Short date: "23/03/2026 23:12:51" → "23 Mar 23:12"
 */
function shortDate(dateStr: string): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const m = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2})/);
  if (m) {
    const month = months[parseInt(m[2], 10) - 1] || m[2];
    return `${parseInt(m[1], 10)} ${month} ${m[4]}`;
  }
  // Fallback: strip seconds
  return dateStr.replace(/(\d{2}:\d{2}):\d{2}/, '$1');
}

/**
 * Shared metadata footer — pill badges with Unicode icons.
 * Icons: # (id) ⏱ (date) ◉ (node) ⚙ (platform) ⧈ (instance)
 * Used by ObservationCard, SummaryCard, and PromptCard.
 */
export function MetadataFooter({ id, date, node, platform, instance }: MetadataFooterProps) {
  const displayInstance = instance || 'default';
  const instanceMuted = !instance;

  return (
    <div className="meta-pills">
      <span className="pill pill--id">
        <span className="pill-ico">#</span>{id}
      </span>
      <span className="pill pill--date">
        <span className="pill-ico">⏱</span>{shortDate(date)}
      </span>
      {node && (
        <span className="pill pill--node" title={node}>
          <span className="pill-ico">◉</span>{node}
        </span>
      )}
      {platform && (
        <span className={`pill ${platformPillClass(platform)}`}>
          <span className="pill-ico">⚙</span>{platform}
        </span>
      )}
      <span
        className={`pill pill--instance${instanceMuted ? ' pill--muted' : ''}`}
        title={`Instance: ${displayInstance}`}
      >
        <span className="pill-ico">⧈</span>{displayInstance}
      </span>
    </div>
  );
}
