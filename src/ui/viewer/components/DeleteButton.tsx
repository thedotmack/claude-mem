import React from 'react';
import { FeedItemType } from '../types';

interface DeleteButtonProps {
  itemType: FeedItemType;
  id: number;
  onDelete: (itemType: FeedItemType, id: number) => void;
}

const CONFIRM_LABELS: Record<FeedItemType, string> = {
  observation: 'observation',
  summary: 'session summary',
  prompt: 'prompt',
};

/**
 * Trash-icon button that deletes a feed item after a confirmation prompt.
 */
export function DeleteButton({ itemType, id, onDelete }: DeleteButtonProps) {
  const handleClick = () => {
    if (window.confirm(`Delete this ${CONFIRM_LABELS[itemType]}? This cannot be undone.`)) {
      onDelete(itemType, id);
    }
  };

  return (
    <button
      className="card-delete-btn"
      onClick={handleClick}
      title={`Delete ${CONFIRM_LABELS[itemType]}`}
      aria-label={`Delete ${CONFIRM_LABELS[itemType]}`}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        <line x1="10" y1="11" x2="10" y2="17"></line>
        <line x1="14" y1="11" x2="14" y2="17"></line>
      </svg>
    </button>
  );
}
