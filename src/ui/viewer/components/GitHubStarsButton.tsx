import React from 'react';
import { useGitHubStars } from '../hooks/useGitHubStars';
import { formatStarCount } from '../utils/formatNumber';

interface GitHubStarsButtonProps {
  username: string;
  repo: string;
  className?: string;
}

export function GitHubStarsButton({ username, repo, className = '' }: GitHubStarsButtonProps) {
  const { stars, isLoading, error } = useGitHubStars(username, repo);
  const repoUrl = `https://github.com/${username}/${repo}`;

  // Graceful degradation: on error, show just the icon (like original static link)
  if (error) {
    return (
      <a
        href={repoUrl}
        target="_blank"
        rel="noopener noreferrer"
        title="GitHub"
        className="icon-link"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
        </svg>
      </a>
    );
  }

  return (
    <a
      href={repoUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`github-stars-btn ${className}`}
      title={`Star us on GitHub${stars !== null ? ` (${stars.toLocaleString()} stars)` : ''}`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: '6px' }}>
        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
      </svg>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: '4px' }}>
        <path d="M12 .587l3.668 7.431 8.2 1.192-5.934 5.787 1.4 8.166L12 18.896l-7.334 3.867 1.4-8.166-5.934-5.787 8.2-1.192z"/>
      </svg>
      <span className={isLoading ? 'stars-loading' : 'stars-count'}>
        {isLoading ? '...' : (stars !== null ? formatStarCount(stars) : '—')}
      </span>
    </a>
  );
}
