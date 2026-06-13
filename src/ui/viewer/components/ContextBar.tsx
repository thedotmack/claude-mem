// CMEM Viewer — docked context header.
// Ported from /tmp/cmem-redesign/cmem-viewer/app-v4.jsx:575-602.
// Shows the scroll-spy-active session's request + stats, or project stats
// when no session is under the bar. Includes the expand/collapse toolbar.

import React from 'react';
import { Icon } from '../ui/icons.js';
import { fmtTime } from '../utils/format.js';
import type { TimelineSession } from '../data/buildTimeline.js';

export interface ProjectStats {
  mem: number;
  sessions: number;
  files: number;
  range: string | null;
}

export interface ContextBarProps {
  ctxGroup: TimelineSession | null;
  projectLabel: string;
  projStats: ProjectStats;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

export function ContextBar({ ctxGroup, projectLabel, projStats, onExpandAll, onCollapseAll }: ContextBarProps) {
  return (
    <div className="context-bar">
      <div className="context-swap" key={ctxGroup ? ctxGroup.session.id : 'project'}>
        {ctxGroup ? (
          <div className="project-head">
            <h1 className="project-title ctx-prompt">{ctxGroup.session.request}</h1>
            <p className="project-sub">
              <span className={'project-dot p-' + ctxGroup.session.project}></span> {ctxGroup.session.project}
              <span className="dot-sep"> · </span>
              {fmtTime(ctxGroup.session.started)}–{fmtTime(ctxGroup.session.ended)}
              <span className="dot-sep"> · </span>
              {ctxGroup.observations.length} {ctxGroup.observations.length === 1 ? 'memory' : 'memories'}
            </p>
          </div>
        ) : (
          <div className="project-head">
            <h1 className="project-title">{projectLabel}</h1>
            <p className="project-sub">
              {projStats.sessions} {projStats.sessions === 1 ? 'session' : 'sessions'}
              <span className="dot-sep"> · </span>
              {projStats.mem.toLocaleString()} memories
              <span className="dot-sep"> · </span>
              {projStats.files} files
              {projStats.range && (
                <React.Fragment>
                  <span className="dot-sep"> · </span>
                  {projStats.range}
                </React.Fragment>
              )}
            </p>
          </div>
        )}
      </div>
      <div className="toolbar-actions">
        <button className="tool-btn" onClick={onExpandAll}>
          <Icon name="chevronsUpDown" size={14} /> Expand all
        </button>
        <button className="tool-btn" onClick={onCollapseAll}>
          <Icon name="chevronsDownUp" size={14} /> Collapse all
        </button>
      </div>
    </div>
  );
}
