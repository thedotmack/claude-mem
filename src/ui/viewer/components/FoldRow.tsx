import React from 'react';
import { ChevronRightIcon } from './icons';

/**
 * The one fold row (decision G5), in the viewer's own parts: a chevron on the left
 * that turns when the fold opens, the label, a count on the right and the shared
 * focus ring; 36px tall on desktop and 44px on touch (C12). The label stays the
 * same open or closed; the chevron and aria-expanded say which.
 */
export function FoldRow({ label, count, open, onToggle, controls }: {
  label: string;
  /** How many things the fold holds, shown at the right end. */
  count?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  /** The id of the element the row opens. */
  controls?: string;
}) {
  return (
    <button type="button" className="fold-row" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <span className="fold-row-chevron" aria-hidden="true"><ChevronRightIcon size={16} /></span>
      <span className="fold-row-label">{label}</span>
      {count !== undefined && count !== null && <span className="fold-row-count">{count}</span>}
    </button>
  );
}
