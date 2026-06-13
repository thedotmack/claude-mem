// CMEM Viewer — topbar.
// Ported from /tmp/cmem-redesign/cmem-viewer/app-v4.jsx:529-566 (header/topbar),
// with the v4 LiveStatus pill (187-213) adapted to the production
// isConnected/isProcessing/queueDepth signals, and entry points for the
// existing real features: Settings, Help (welcome), Logs, and the Tweaks popover.

import React from 'react';
import { Icon } from '../ui/icons.js';
import { SearchBar } from './SearchBar.js';
import type { ViewerData } from '../data/viewer-types.js';

export interface HeaderProps {
  data: ViewerData;
  projects: string[];
  currentFilter: string;
  onFilterChange: (project: string) => void;
  isConnected: boolean;
  isProcessing: boolean;
  queueDepth: number;
  onToggleSide: () => void;
  sideOpen: boolean;
  // SearchBar wiring
  onAsk: (q: string) => void;
  onJump: (obsId: number) => void;
  onFile: (path: string) => void;
  onConcept: (c: string) => void;
  // real-feature entry points
  onOpenSettings: () => void;
  onShowHelp: () => void;
  onToggleLogs: () => void;
  onToggleTweaks: () => void;
}

// Live-status pill — derived from the production connection signals.
function LiveStatus({
  isConnected,
  isProcessing,
  queueDepth
}: {
  isConnected: boolean;
  isProcessing: boolean;
  queueDepth: number;
}) {
  const state = isConnected ? 'ok' : 'err';
  const label = isConnected ? 'live' : 'offline';
  const title = isConnected ? 'claude-mem worker connected' : 'claude-mem worker unreachable';
  return (
    <span className={'live-pill ' + state} title={title} style={{ cursor: 'default' }}>
      <span className="live-dot"></span>
      <span>{label}</span>
      {isProcessing && (
        <span className="live-queue">
          processing{queueDepth > 0 ? ' · ' + queueDepth : ''}
        </span>
      )}
    </span>
  );
}

export function Header({
  data,
  projects,
  currentFilter,
  onFilterChange,
  isConnected,
  isProcessing,
  queueDepth,
  onToggleSide,
  sideOpen,
  onAsk,
  onJump,
  onFile,
  onConcept,
  onOpenSettings,
  onShowHelp,
  onToggleLogs,
  onToggleTweaks
}: HeaderProps) {
  return (
    <header className="topbar" data-screen-label="Header">
      <div className="brand">
        <button
          className="side-toggle"
          onClick={onToggleSide}
          title="Files & notes"
          aria-label="Open files and notes"
          aria-expanded={sideOpen}
        >
          <Icon name="panelLeft" size={16} />
        </button>
        <img src="claude-mem-logomark.webp" alt="cmem" className="brand-mark" />
        <span className="brand-word">cmem <em>viewer</em></span>
      </div>

      <SearchBar data={data} onAsk={onAsk} onJump={onJump} onFile={onFile} onConcept={onConcept} />

      <div className="top-right">
        <LiveStatus isConnected={isConnected} isProcessing={isProcessing} queueDepth={queueDepth} />

        <div className="project-select-wrap">
          <Icon name="folder" size={14} className="project-glyph" />
          <select
            className="project-select"
            value={currentFilter}
            onChange={(e) => onFilterChange(e.target.value)}
            aria-label="Filter by project"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <Icon name="chevronDown" size={13} className="project-caret" />
        </div>

        <button className="icon-btn" onClick={onShowHelp} title="Help" aria-label="Show welcome card">
          <Icon name="lightbulb" size={16} />
        </button>
        <button className="icon-btn" onClick={onToggleLogs} title="Console logs" aria-label="Toggle console logs">
          <Icon name="fileCode" size={16} />
        </button>
        <button className="icon-btn" onClick={onToggleTweaks} title="Appearance" aria-label="Appearance">
          <Icon name="sparkles" size={16} />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="Settings" aria-label="Settings">
          <Icon name="wrench" size={16} />
        </button>
      </div>
    </header>
  );
}
