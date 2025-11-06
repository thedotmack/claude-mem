import React from 'react';

interface SummarySkeletonProps {
  sessionId: string;
  project?: string;
}

export function SummarySkeleton({ sessionId, project }: SummarySkeletonProps) {
  return (
    <div className="card summary-card summary-skeleton">
      <div className="card-header">
        <span className="card-type">SUMMARY</span>
        {project && <span>{project}</span>}
        <div className="processing-indicator">
          <div className="spinner"></div>
          <span>Generating...</span>
        </div>
      </div>
      <div className="skeleton-line skeleton-title"></div>
      <div className="skeleton-line skeleton-subtitle"></div>
      <div className="skeleton-line skeleton-subtitle short"></div>
      <div className="card-meta">Session: {sessionId}</div>
    </div>
  );
}
