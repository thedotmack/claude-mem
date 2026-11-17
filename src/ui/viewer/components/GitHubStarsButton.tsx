import React from 'react';
import { useI18n, interpolate } from '../../i18n';
import { formatCount } from '../utils/formatters';
import { formatStarCount, useGitHubStars } from '../hooks/useGitHubStars';
import { GitHubIcon, StarIcon } from './icons';

interface GitHubStarsButtonProps {
  username: string;
  repo: string;
  className?: string;
}

/**
 * A worded "Star" link with the live count in tabular figures, a visible edge and
 * the shared focus ring. The header keeps it in its "…" menu; the component stays
 * mountable for any layout that wants it on the bar.
 */
export function GitHubStarsButton({ username, repo, className = '' }: GitHubStarsButtonProps) {
  const { t } = useI18n();
  const { stars, isLoading, failed, repoUrl } = useGitHubStars(username, repo);

  if (failed) {
    return (
      <a href={repoUrl} target="_blank" rel="noopener noreferrer" title={t('GitHub')} aria-label={t('GitHub')} className="icon-link">
        <GitHubIcon size={16} />
      </a>
    );
  }

  const starTitle = stars !== null
    ? interpolate(t('Star us on GitHub ({count} stars)'), { count: formatCount(stars) })
    : t('Star us on GitHub');

  return (
    <a href={repoUrl} target="_blank" rel="noopener noreferrer" className={`github-stars-btn ${className}`.trim()} title={starTitle} aria-label={starTitle}>
      <GitHubIcon size={16} />
      <span className="github-stars-word">{t('Star')}</span>
      <span className="github-stars-divider" aria-hidden="true" />
      <StarIcon size={14} />
      <span className={isLoading ? 'stars-loading' : 'stars-count'}>
        {isLoading ? '…' : (stars !== null ? formatStarCount(stars) : '—')}
      </span>
    </a>
  );
}
