import React from 'react';
import { Summary } from '../types';
import { formatDate } from '../utils/formatters';

interface SummaryCardProps {
  summary: Summary;
}

export function SummaryCard({ summary }: SummaryCardProps) {
  const date = formatDate(summary.created_at_epoch);

  return (
    <div className="card summary-card">
      <div className="card-header">
        <div className="card-header-left">
          <span className="card-type">SUMMARY</span>
          <span className="card-project">{summary.project}</span>
        </div>
      </div>
      {summary.request && (
        <div className="card-title">Request: {summary.request}</div>
      )}
      {summary.investigated && (
        <div className="card-subtitle">Investigated: {summary.investigated}</div>
      )}
      {summary.learned && (
        <div className="card-subtitle">Learned: {summary.learned}</div>
      )}
      {summary.completed && (
        <div className="card-subtitle">Completed: {summary.completed}</div>
      )}
      {summary.next_steps && (
        <div className="card-subtitle">Next: {summary.next_steps}</div>
      )}
      <div className="card-meta">
        <span className="meta-date">#{summary.id} • {date}</span>
      </div>
    </div>
  );
}
