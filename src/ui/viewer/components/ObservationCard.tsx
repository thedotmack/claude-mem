import React from 'react';
import { Observation } from '../types';
import { formatDate } from '../utils/formatters';

interface ObservationCardProps {
  observation: Observation;
}

export function ObservationCard({ observation }: ObservationCardProps) {
  const date = formatDate(observation.created_at_epoch);

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-type">{observation.type}</span>
        <span>{observation.project}</span>
      </div>
      <div className="card-title">{observation.title || 'Untitled'}</div>
      {observation.subtitle && (
        <div className="card-subtitle">{observation.subtitle}</div>
      )}
      <div className="card-meta">#{observation.id} • {date}</div>
    </div>
  );
}
