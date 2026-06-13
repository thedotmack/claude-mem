// CMEM Viewer — type + concept filter chips bar.
// Ported from /tmp/cmem-redesign/cmem-viewer/app-v4.jsx:59-112.
// Filters use Set<string> (production signature); chip handlers toggle entries.

import React, { useMemo } from 'react';
import { Icon, TYPE_META } from '../ui/icons.js';
import type { ViewerData } from '../data/viewer-types.js';

export interface ChipFilters {
  project: string;
  types: Set<string>;
  concepts: Set<string>;
  file: string | null;
}

export interface ChipsBarProps {
  data: ViewerData;
  filters: ChipFilters;
  onToggleType: (type: string) => void;
  onToggleConcept: (concept: string) => void;
  onClear: () => void;
}

export function ChipsBar({ data, filters, onToggleType, onToggleConcept, onClear }: ChipsBarProps) {
  const conceptCounts = useMemo(() => {
    const m = new Map<string, number>();
    data.observations.forEach((o) => {
      if (filters.project && o.project !== filters.project) return;
      o.concepts.forEach((c) => m.set(c, (m.get(c) || 0) + 1));
    });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [data, filters.project]);

  const anyActive = filters.types.size > 0 || filters.concepts.size > 0;

  return (
    <div className="chips-bar">
      <div className="chips-scroll">
        {Object.entries(TYPE_META).map(([t, m]) => {
          const active = filters.types.has(t);
          return (
            <button
              key={t}
              className={'type-chip' + (active ? ' active' : '')}
              style={active ? { background: m.bg, color: m.fg, borderColor: 'transparent' } : {}}
              onClick={() => onToggleType(t)}
            >
              <Icon name={m.icon} size={13} />
              {m.label}
            </button>
          );
        })}
        <span className="chips-divider"></span>
        {conceptCounts.map(([c, n]) => (
          <button
            key={c}
            className={'concept-chip bar' + (filters.concepts.has(c) ? ' active' : '')}
            onClick={() => onToggleConcept(c)}
          >
            {c}
            <span className="chip-count">{n}</span>
          </button>
        ))}
        {anyActive && (
          <button className="chips-clear" onClick={onClear}>
            <Icon name="x" size={12} /> clear
          </button>
        )}
      </div>
    </div>
  );
}
