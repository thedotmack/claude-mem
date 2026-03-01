import React from 'react';
import { useAnalytics } from '../hooks/useAnalytics';
import { formatTokenCount } from '../utils/format';

interface AnalyticsBarProps {
  project: string;
}

const TIME_RANGE_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: '7d', value: 7 },
  { label: '30d', value: 30 },
  { label: '90d', value: 90 },
  { label: 'All', value: null },
];

const TOOLTIPS = {
  stored: 'Estimated token size of all stored observations. Represents the compressed knowledge footprint.',
  work: 'AI tokens invested in research, building, and decisions',
  recalled: 'Tokens actually delivered into sessions via context injection (session start, prompt submit, and MCP search).',
  saved: 'Net tokens saved by reusing compressed context instead of re-doing the original work. Calculated as Work minus Stored minus Recalled.',
  obs: 'Observations recorded / distinct Claude sessions (one session can have multiple summaries)',
} as const;

/**
 * Vertical card bar showing token analytics stats.
 * Each card shows: uppercase label, large colored value, muted subtitle.
 * Hovering or focusing a card shows a descriptive tooltip via CSS.
 */
export const AnalyticsBar = React.memo(function AnalyticsBar({ project }: AnalyticsBarProps) {
  const { data, isLoading, timeRange, setTimeRange } = useAnalytics(project);

  const hasSavings = (data?.savingsTokens ?? 0) > 0;
  const savingsClass = hasSavings ? 'analytics-card--green' : 'analytics-card--muted';

  const savedTokens = (data?.workTokens ?? 0) - (data?.readTokens ?? 0) - (data?.savingsTokens ?? 0);
  const hasSaved = savedTokens > 0;
  const savedPercent = (data?.workTokens ?? 0) > 0
    ? Math.round((savedTokens / (data?.workTokens ?? 1)) * 100)
    : 0;
  const savedClass = hasSaved ? 'analytics-card--green' : 'analytics-card--muted';

  return (
    <div className="analytics-bar" role="region" aria-label="Token analytics">
      <div className="analytics-bar__cards" aria-busy={isLoading}>
        <div className="analytics-card analytics-card--purple" tabIndex={0}>
          <span className="analytics-card__label" title="Work tokens">Work</span>
          <span className="analytics-card__value">
            {isLoading ? <span className="analytics-skeleton" role="status" aria-label="Loading work tokens" /> : formatTokenCount(data?.workTokens ?? 0)}
          </span>
          <span className="analytics-card__subtitle">tokens</span>
          <span className="analytics-tooltip" role="tooltip">{TOOLTIPS.work}</span>
        </div>

        <div className="analytics-card analytics-card--accent" tabIndex={0}>
          <span className="analytics-card__label" title="Stored tokens">Stored</span>
          <span className="analytics-card__value">
            {isLoading ? <span className="analytics-skeleton" role="status" aria-label="Loading stored tokens" /> : formatTokenCount(data?.readTokens ?? 0)}
          </span>
          <span className="analytics-card__subtitle">tokens</span>
          <span className="analytics-tooltip" role="tooltip">{TOOLTIPS.stored}</span>
        </div>

        <div className={`analytics-card ${savingsClass}`} tabIndex={0}>
          <span className="analytics-card__label" title="Recalled tokens">Recalled</span>
          <span className="analytics-card__value">
            {isLoading ? <span className="analytics-skeleton" role="status" aria-label="Loading recalled tokens" /> : (hasSavings ? formatTokenCount(data?.savingsTokens ?? 0) : '\u2014')}
          </span>
          <span className="analytics-card__subtitle">tokens recalled</span>
          <span className="analytics-tooltip" role="tooltip">{TOOLTIPS.recalled}</span>
        </div>

        <div className={`analytics-card ${savedClass}`} tabIndex={0}>
          <span className="analytics-card__label" title="Saved tokens">Saved</span>
          <span className="analytics-card__value">
            {isLoading ? <span className="analytics-skeleton" role="status" aria-label="Loading saved tokens" /> : (hasSaved ? `${formatTokenCount(savedTokens)} (${savedPercent}%)` : '\u2014')}
          </span>
          <span className="analytics-card__subtitle">tokens saved</span>
          <span className="analytics-tooltip" role="tooltip">{TOOLTIPS.saved}</span>
        </div>

        <div className="analytics-card" tabIndex={0}>
          <span className="analytics-card__label" title="Observations">Obs</span>
          <span className="analytics-card__value">
            {isLoading ? <span className="analytics-skeleton" role="status" aria-label="Loading observations" /> : String(data?.observationCount ?? 0)}
          </span>
          {!isLoading && (
            <span className="analytics-card__subtitle" title="sessions">
              {data ? String(data.sessionCount) : '0'} sessions
            </span>
          )}
          <span className="analytics-tooltip" role="tooltip">{TOOLTIPS.obs}</span>
        </div>
      </div>

      <div className="analytics-time-range" role="group" aria-label="Time range">
        {TIME_RANGE_OPTIONS.map(({ label, value }) => (
          <button
            key={label}
            className={`analytics-time-range__btn${timeRange === value ? ' analytics-time-range__btn--active' : ''}`}
            onClick={() => { setTimeRange(value); }}
            aria-pressed={timeRange === value}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
});
