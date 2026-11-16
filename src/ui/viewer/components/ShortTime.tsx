import React, { useState } from 'react';
import { useI18n } from '../../i18n';
import { formatDate, formatShortTime } from '../utils/formatters';

/**
 * A short local time ("6:07 pm") that shows the full stamp on hover (title), on
 * keyboard focus (tooltip) and on tap or click (the full stamp replaces the short one).
 * A stamp that is not a real time reads "Unknown time" instead of stopping the list.
 */
export function ShortTime({ epoch, className = '', detail }: {
  epoch: number;
  className?: string;
  /** Shown after the full stamp (a row's id when the row has no other place for it). */
  detail?: string;
}) {
  const { t } = useI18n();
  const [showFull, setShowFull] = useState(false);
  const date = new Date(epoch);
  const known = Number.isFinite(date.getTime());
  const stamp = known ? formatDate(epoch) : t('Unknown time');
  const full = detail ? `${stamp} · ${detail}` : stamp;
  const shown = showFull ? full : known ? formatShortTime(epoch) : stamp;
  return (
    <button
      type="button"
      className={`short-time${className ? ` ${className}` : ''}`}
      title={full}
      data-full={full}
      aria-label={full}
      aria-pressed={showFull}
      onClick={() => setShowFull(value => !value)}
    >
      {known ? <time dateTime={date.toISOString()}>{shown}</time> : shown}
    </button>
  );
}
