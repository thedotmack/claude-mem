import React, { useState } from 'react';
import { useI18n } from '../../i18n';
import { formatDate, formatShortTime } from '../utils/formatters';

/**
 * Short words for a time that show the full stamp on hover (title), on keyboard focus (tooltip, .short-time in
 * viewer-template.html) and on tap or click (the full words replace the short ones): G9 and G10.
 */
export function StampToggle({ shown, full, dateTime, className = '' }: {
  shown: string;
  full: string;
  /** The machine-readable time of a single stamp, for the <time> element. */
  dateTime?: string;
  className?: string;
}) {
  const [showFull, setShowFull] = useState(false);
  const text = showFull ? full : shown;
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
      {dateTime ? <time dateTime={dateTime}>{text}</time> : text}
    </button>
  );
}

/**
 * A short local time ("6:07 pm") that shows the full stamp on hover, focus and tap (StampToggle).
 * A stamp that is not a real time reads "Unknown time" instead of stopping the list.
 */
export function ShortTime({ epoch, className = '', detail }: {
  epoch: number;
  className?: string;
  /** Shown after the full stamp (a row's id when the row has no other place for it). */
  detail?: string;
}) {
  const { t } = useI18n();
  const date = new Date(epoch);
  const known = Number.isFinite(date.getTime());
  const stamp = known ? formatDate(epoch) : t('Unknown time');
  const full = detail ? `${stamp} · ${detail}` : stamp;
  return (
    <StampToggle shown={known ? formatShortTime(epoch) : stamp} full={full} dateTime={known ? date.toISOString() : undefined}
      className={className} />
  );
}
