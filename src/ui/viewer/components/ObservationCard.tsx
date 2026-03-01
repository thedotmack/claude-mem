import React, { useState, useCallback } from 'react';
import type { Observation } from '../types';
import { formatDate } from '../utils/formatters';

interface ObservationCardProps {
  observation: Observation;
}

// Safely parse a JSON string expected to be a string[]. Returns [] on null/malformed input.
export function safeParseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

// Merge subtitle into narrative — exported for unit testing
export function mergeNarrative(subtitle: string | null, title: string | null, narrative: string | null): string | null {
  if (subtitle && subtitle !== title) {
    return `${narrative ?? ''}\n\n${subtitle}`.trim();
  }
  return narrative;
}

// Helper to strip project root from file paths — exported for unit testing
export function stripProjectRoot(filePath: string): string {
  // Try to extract relative path by finding common project markers
  const markers = ['/Scripts/', '/src/', '/plugin/', '/docs/'];

  for (const marker of markers) {
    const index = filePath.indexOf(marker);
    if (index !== -1) {
      // Keep the marker and everything after it
      return filePath.substring(index + 1);
    }
  }

  // Fallback: if path contains project name, strip everything before it
  const projectIndex = filePath.indexOf('magic-claude-mem/');
  if (projectIndex !== -1) {
    return filePath.substring(projectIndex + 'magic-claude-mem/'.length);
  }

  // If no markers found, return last 3 segments or original path
  const parts = filePath.split('/');
  return parts.length > 3 ? parts.slice(-3).join('/') : filePath;
}

export const ObservationCard = React.memo(function ObservationCard({ observation }: ObservationCardProps) {
  const [expanded, setExpanded] = useState(false);
  const date = formatDate(observation.created_at_epoch);

  // Parse JSON fields safely — malformed data from API should not crash the card
  const facts: string[] = safeParseJsonArray(observation.facts);
  const concepts: string[] = safeParseJsonArray(observation.concepts);
  const filesRead: string[] = safeParseJsonArray(observation.files_read).map(stripProjectRoot);
  const filesModified: string[] = safeParseJsonArray(observation.files_modified).map(stripProjectRoot);

  const mergedNarrative = mergeNarrative(observation.subtitle, observation.title, observation.narrative);

  const hasExpandableContent = facts.length > 0 || mergedNarrative;

  const toggleExpand = useCallback(() => setExpanded(prev => !prev), []);

  return (
    <div
      className={`card observation-card${hasExpandableContent ? ' observation-card--expandable' : ''}`}
      data-obs-type={observation.type}
      data-testid="obs-card"
      aria-expanded={expanded}
      aria-label={hasExpandableContent ? `${observation.title ?? 'Observation'} — ${expanded ? 'collapse' : 'expand'}` : undefined}
      role={hasExpandableContent ? 'button' : undefined}
      tabIndex={hasExpandableContent ? 0 : undefined}
      onClick={hasExpandableContent ? toggleExpand : undefined}
      onKeyDown={hasExpandableContent ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleExpand();
        }
      } : undefined}
    >
      {/* Header */}
      <div className="card-header">
        <div className="card-header-left">
          <span className="observation-card__type-badge">{observation.type || 'observation'}</span>
          {observation.priority && observation.priority !== 'informational' && (
            <span
              className="observation-card__priority-badge"
              data-priority={observation.priority}
              style={{
                backgroundColor: observation.priority === 'critical' ? '#CC3311' : '#EE7733',
                color: '#fff',
              }}
            >
              {observation.priority}
            </span>
          )}
          <span className="card-project">{observation.project}</span>
        </div>
        <span className="meta-date">#{observation.id} • {date}</span>
      </div>

      {/* Title */}
      <div className="card-title">{observation.title ?? 'Untitled'}</div>

      {/* Concepts and files — always visible */}
      {(concepts.length > 0 || filesRead.length > 0 || filesModified.length > 0) && (
        <div className="card__concepts">
          {concepts.map((concept, i) => (
            <span key={`${concept}-${String(i)}`} className="observation-card__concept-chip">
              {concept}
            </span>
          ))}
          {filesRead.length > 0 && (
            <span className="meta-files">
              <span className="file-label">read:</span> {filesRead.join(', ')}
            </span>
          )}
          {filesModified.length > 0 && (
            <span className="meta-files">
              <span className="file-label">modified:</span> {filesModified.join(', ')}
            </span>
          )}
        </div>
      )}

      {/* Expandable facts section */}
      {expanded && hasExpandableContent && (
        <div className="card-facts" data-testid="obs-card-facts">
          {facts.length > 0 && (
            <ul className="facts-list">
              {facts.map((fact, i) => (
                <li key={`fact-${String(i)}`}>{fact}</li>
              ))}
            </ul>
          )}
          {mergedNarrative && (
            <div className="narrative">
              {mergedNarrative}
            </div>
          )}
        </div>
      )}

      {/* Metadata footer */}
      <div className="card-meta">
        {hasExpandableContent && (
          <span className="expand-hint">{expanded ? '▲ collapse' : '▼ expand'}</span>
        )}
      </div>
    </div>
  );
});
