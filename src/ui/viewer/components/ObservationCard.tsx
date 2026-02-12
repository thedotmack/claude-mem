import React, { useState, useMemo } from 'react';
import { Observation } from '../types';
import { formatDate } from '../utils/formatters';

interface ObservationCardProps {
  observation: Observation;
}

interface ParsedContent {
  facts: string[];
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
  hasFactsContent: boolean;
}

// Path processing with cached patterns
const PROJECT_MARKERS = ['/Scripts/', '/src/', '/plugin/', '/docs/'];
const stripProjectRoot = (filePath: string): string => {
  // Find first matching marker
  for (const marker of PROJECT_MARKERS) {
    const index = filePath.indexOf(marker);
    if (index !== -1) return filePath.substring(index + 1);
  }

  // Fallback patterns
  const projectIndex = filePath.indexOf('claude-mem/');
  if (projectIndex !== -1) {
    return filePath.substring(projectIndex + 'claude-mem/'.length);
  }

  // Return last 3 segments for long paths
  const segments = filePath.split('/');
  return segments.length > 3 ? segments.slice(-3).join('/') : filePath;
};

// Safe JSON parsing with fallback
const parseJsonField = <T,>(field: string | null, fallback: T): T => {
  if (!field) return fallback;
  try {
    return JSON.parse(field) as T;
  } catch {
    return fallback;
  }
};

export function ObservationCard({ observation }: ObservationCardProps) {
  const [viewMode, setViewMode] = useState<'default' | 'facts' | 'narrative'>('default');

  // Memoized content parsing with error handling
  const parsedContent = useMemo<ParsedContent>(() => {
    const facts = parseJsonField<string[]>(observation.facts, []);
    const concepts = parseJsonField<string[]>(observation.concepts, []);
    const rawFilesRead = parseJsonField<string[]>(observation.files_read, []);
    const rawFilesModified = parseJsonField<string[]>(observation.files_modified, []);

    const filesRead = rawFilesRead.map(stripProjectRoot);
    const filesModified = rawFilesModified.map(stripProjectRoot);

    return {
      facts,
      concepts,
      filesRead,
      filesModified,
      hasFactsContent: facts.length > 0 || concepts.length > 0 || filesRead.length > 0 || filesModified.length > 0,
    };
  }, [observation.facts, observation.concepts, observation.files_read, observation.files_modified]);

  // Toggle handlers with exclusive state logic
  const toggleViewMode = (targetMode: typeof viewMode) => {
    setViewMode(prev => prev === targetMode ? 'default' : targetMode);
  };

  // View mode components for better organization
  const ViewModeToggle = ({ mode, icon, label, isAvailable }: {
    mode: typeof viewMode;
    icon: React.ReactNode;
    label: string;
    isAvailable: boolean;
  }) => (
    isAvailable ? (
      <button
        className={`view-mode-toggle ${viewMode === mode ? 'active' : ''}`}
        onClick={() => toggleViewMode(mode)}
        aria-label={`Toggle ${label} view`}
      >
        {icon}
        <span>{label}</span>
      </button>
    ) : null
  );

  const ConceptBadge = ({ concept }: { concept: string }) => (
    <span className="concept-badge" style={{
      padding: '2px 8px',
      background: 'var(--color-type-badge-bg)',
      color: 'var(--color-type-badge-text)',
      borderRadius: '3px',
      fontWeight: '500',
      fontSize: '10px'
    }}>
      {concept}
    </span>
  );

  const FilesList = ({ files, label }: { files: string[]; label: string }) => (
    files.length > 0 ? (
      <span className="meta-files">
        <span className="file-label">{label}:</span> {files.join(', ')}
      </span>
    ) : null
  );

  return (
    <div className="card">
      {/* Header */}
      <div className="card-header">
        <div className="card-header-left">
          <span className={`card-type type-${observation.type}`}>
            {observation.type}
          </span>
          <span className="card-project">{observation.project}</span>
        </div>
        
        {/* View mode toggles */}
        <div className="view-mode-toggles">
          <ViewModeToggle
            mode="facts"
            label="facts"
            isAvailable={parsedContent.hasFactsContent}
            icon={
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="9 11 12 14 22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            }
          />
          <ViewModeToggle
            mode="narrative"
            label="narrative"
            isAvailable={!!observation.narrative}
            icon={
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
            }
          />
        </div>
      </div>

      {/* Title */}
      <div className="card-title">{observation.title || 'Untitled'}</div>

      {/* Content based on view mode */}
      <div className="view-mode-content">
        {viewMode === 'default' && observation.subtitle && (
          <div className="card-subtitle">{observation.subtitle}</div>
        )}
        
        {viewMode === 'facts' && parsedContent.facts.length > 0 && (
          <ul className="facts-list">
            {parsedContent.facts.map((fact, index) => (
              <li key={index}>{fact}</li>
            ))}
          </ul>
        )}
        
        {viewMode === 'narrative' && observation.narrative && (
          <div className="narrative">{observation.narrative}</div>
        )}
      </div>

      {/* Metadata footer */}
      <div className="card-meta">
        <span className="meta-date">
          #{observation.id} • {formatDate(observation.created_at_epoch)}
        </span>
        
        {/* Extended metadata shown in facts view */}
        {viewMode === 'facts' && (parsedContent.concepts.length > 0 || 
                                    parsedContent.filesRead.length > 0 || 
                                    parsedContent.filesModified.length > 0) && (
          <div className="extended-meta">
            {parsedContent.concepts.map((concept, index) => (
              <ConceptBadge key={index} concept={concept} />
            ))}
            <FilesList files={parsedContent.filesRead} label="read" />
            <FilesList files={parsedContent.filesModified} label="modified" />
          </div>
        )}
      </div>
    </div>
  );
}
