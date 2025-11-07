import React, { useState } from 'react';
import { Observation } from '../types';
import { formatDate } from '../utils/formatters';

interface ObservationCardProps {
  observation: Observation;
}

export function ObservationCard({ observation }: ObservationCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const date = formatDate(observation.created_at_epoch);

  // Parse JSON fields
  const facts = observation.facts ? JSON.parse(observation.facts) : [];
  const concepts = observation.concepts ? JSON.parse(observation.concepts) : [];
  const filesRead = observation.files_read ? JSON.parse(observation.files_read) : [];
  const filesModified = observation.files_modified ? JSON.parse(observation.files_modified) : [];

  return (
    <div className={`card ${isExpanded ? 'card-expanded' : ''}`}>
      {/* Header - always visible */}
      <div className="card-header">
        <span className={`card-type type-${observation.type}`}>
          {observation.type}
        </span>
        <span className="card-project">{observation.project}</span>
      </div>

      {/* Title/Subtitle - always visible */}
      <div className="card-title">{observation.title || 'Untitled'}</div>
      {observation.subtitle && (
        <div className="card-subtitle">{observation.subtitle}</div>
      )}

      {/* Metadata + Expand button - always visible */}
      <div className="card-meta">
        <span>#{observation.id} • {date}</span>
        <button
          className="expand-toggle"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? '▲ Less' : '▼ More'}
        </button>
      </div>

      {/* Expanded content - conditional */}
      {isExpanded && (
        <div className="card-expanded-content">

          {/* Narrative Section */}
          {observation.narrative && (
            <div className="card-section">
              <div className="section-header">📝 Narrative</div>
              <div className="section-content narrative">
                {observation.narrative}
              </div>
            </div>
          )}

          {/* Facts Section */}
          {facts.length > 0 && (
            <div className="card-section">
              <div className="section-header">📌 Key Facts</div>
              <ul className="section-content facts-list">
                {facts.map((fact: string, i: number) => (
                  <li key={i}>{fact}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Concepts Section */}
          {concepts.length > 0 && (
            <div className="card-section">
              <div className="section-header">🏷️ Concepts</div>
              <div className="section-content concepts">
                {concepts.map((concept: string, i: number) => (
                  <span key={i} className="concept-tag">{concept}</span>
                ))}
              </div>
            </div>
          )}

          {/* Files Section */}
          {(filesRead.length > 0 || filesModified.length > 0) && (
            <div className="card-section">
              <div className="section-header">📁 Files</div>
              <div className="section-content files">
                {filesRead.length > 0 && (
                  <div className="file-group">
                    <div className="file-group-label">📖 Read:</div>
                    {filesRead.map((file: string, i: number) => (
                      <div key={i} className="file-path">{file}</div>
                    ))}
                  </div>
                )}
                {filesModified.length > 0 && (
                  <div className="file-group">
                    <div className="file-group-label">✏️ Modified:</div>
                    {filesModified.map((file: string, i: number) => (
                      <div key={i} className="file-path">{file}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Session Info Section */}
          <div className="card-section">
            <div className="section-header">🔗 Session Info</div>
            <div className="section-content session-info">
              {observation.prompt_number && (
                <span>Prompt #{observation.prompt_number}</span>
              )}
              {observation.sdk_session_id && (
                <span className="session-id">
                  Session: {observation.sdk_session_id.substring(0, 8)}...
                </span>
              )}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
