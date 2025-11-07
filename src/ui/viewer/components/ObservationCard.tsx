import React, { useState } from 'react';
import { Observation } from '../types';
import { formatDate } from '../utils/formatters';

interface ObservationCardProps {
  observation: Observation;
}

// Helper to strip project root from file paths
function stripProjectRoot(filePath: string): string {
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
  const projectIndex = filePath.indexOf('claude-mem/');
  if (projectIndex !== -1) {
    return filePath.substring(projectIndex + 'claude-mem/'.length);
  }

  // If no markers found, return basename or original path
  const parts = filePath.split('/');
  return parts.length > 3 ? parts.slice(-3).join('/') : filePath;
}

export function ObservationCard({ observation }: ObservationCardProps) {
  const [showFacts, setShowFacts] = useState(false);
  const [showNarrative, setShowNarrative] = useState(false);
  const date = formatDate(observation.created_at_epoch);

  // Parse JSON fields
  const facts = observation.facts ? JSON.parse(observation.facts) : [];
  const concepts = observation.concepts ? JSON.parse(observation.concepts) : [];
  const filesRead = observation.files_read ? JSON.parse(observation.files_read).map(stripProjectRoot) : [];
  const filesModified = observation.files_modified ? JSON.parse(observation.files_modified).map(stripProjectRoot) : [];

  // Show facts toggle if there are facts, concepts, or files
  const hasFactsContent = facts.length > 0 || concepts.length > 0 || filesRead.length > 0 || filesModified.length > 0;

  return (
    <div className="card">
      {/* Header with toggle buttons in top right */}
      <div className="card-header">
        <div className="card-header-left">
          <span className={`card-type type-${observation.type}`}>
            {observation.type}
          </span>
          <span className="card-project">{observation.project}</span>
        </div>
        <div className="view-mode-toggles">
          {hasFactsContent && (
            <button
              className={`view-mode-toggle ${showFacts ? 'active' : ''}`}
              onClick={() => {
                setShowFacts(!showFacts);
                if (!showFacts) setShowNarrative(false); // Turn off narrative when turning on facts
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 11 12 14 22 4"></polyline>
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
              </svg>
              <span>facts</span>
            </button>
          )}
          {observation.narrative && (
            <button
              className={`view-mode-toggle ${showNarrative ? 'active' : ''}`}
              onClick={() => {
                setShowNarrative(!showNarrative);
                if (!showNarrative) setShowFacts(false); // Turn off facts when turning on narrative
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
              </svg>
              <span>narrative</span>
            </button>
          )}
        </div>
      </div>

      {/* Title */}
      <div className="card-title">{observation.title || 'Untitled'}</div>

      {/* Content based on toggle state */}
      <div className="view-mode-content">
        {!showFacts && !showNarrative && observation.subtitle && (
          <div className="card-subtitle">{observation.subtitle}</div>
        )}
        {showFacts && facts.length > 0 && (
          <ul className="facts-list">
            {facts.map((fact: string, i: number) => (
              <li key={i}>{fact}</li>
            ))}
          </ul>
        )}
        {showNarrative && observation.narrative && (
          <div className="narrative">
            {observation.narrative}
          </div>
        )}
      </div>

      {/* Metadata footer - id, date, and conditionally concepts/files when facts toggle is on */}
      <div className="card-meta">
        <span className="meta-date">#{observation.id} • {date}</span>
        {showFacts && (concepts.length > 0 || filesRead.length > 0 || filesModified.length > 0) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
            {concepts.map((concept: string, i: number) => (
              <span key={i} style={{
                padding: '2px 8px',
                background: 'var(--color-type-badge-bg)',
                color: 'var(--color-type-badge-text)',
                borderRadius: '3px',
                fontWeight: '500',
                fontSize: '10px'
              }}>
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
      </div>
    </div>
  );
}
