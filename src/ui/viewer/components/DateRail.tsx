// CMEM Viewer — left date rail.
// Ported from /tmp/cmem-redesign/cmem-viewer/app-v4.jsx:289-315.
// One `rail-day` button per day; click scrolls to the day; `aria-current`
// marks the scroll-spy-active day.

import React from 'react';
import { fmtDayLabel } from '../utils/format.js';
import type { DayGroup } from '../data/buildTimeline.js';

export interface DateRailProps {
  days: DayGroup[];
  activeKey: string | null;
  onJump: (key: string) => void;
}

export function DateRail({ days, activeKey, onJump }: DateRailProps) {
  if (days.length === 0) return null;
  return (
    <nav className="date-rail" aria-label="Jump to a day" data-screen-label="Date rail">
      {days.map((d) => {
        const label = fmtDayLabel(d.epoch);
        const date = new Date(d.epoch * 1000);
        const lead = label.lead === 'Today' ? 'Today' : date.toLocaleDateString([], { weekday: 'short' });
        const n = d.sessions.reduce((m, g) => m + g.observations.length, 0);
        const active = activeKey === d.key;
        return (
          <button
            key={d.key}
            className={'rail-day' + (active ? ' active' : '')}
            onClick={() => onJump(d.key)}
            title={label.lead + ' — ' + label.rest + ' · ' + n + (n === 1 ? ' memory' : ' memories')}
            aria-current={active ? 'date' : undefined}
          >
            <span className="rail-lead">{lead}</span>
            <span className="rail-date">{date.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
            <span className="rail-count">{n}</span>
          </button>
        );
      })}
    </nav>
  );
}
