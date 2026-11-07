import React, { useState } from 'react';
import { deleteFeedItem, type DeletableItemType } from '../utils/feed-deletion';

interface DeleteButtonProps {
  itemType: DeletableItemType;
  id: number;
  onDeleted: (itemType: DeletableItemType, id: number) => void;
}

const CONFIRM_LABELS: Record<DeletableItemType, string> = {
  observation: 'observation',
  summary: 'session summary',
};

/**
 * Trash-icon button that deletes a feed item after a confirmation prompt. A
 * refused delete (synced from another device, cloud sync unavailable, worker
 * down) is shown inline next to the button instead of failing silently.
 */
export function DeleteButton({ itemType, id, onDeleted }: DeleteButtonProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const handleClick = async () => {
    if (!window.confirm(`Delete this ${CONFIRM_LABELS[itemType]}? This cannot be undone.`)) return;
    setIsDeleting(true);
    setFailure(null);
    try {
      await deleteFeedItem(itemType, id);
      onDeleted(itemType, id);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setIsDeleting(false);
    }
  };

  return (
    <>
      <button
        className="card-delete-btn"
        onClick={handleClick}
        disabled={isDeleting}
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
      {failure && <span className="card-delete-error" role="alert">{failure}</span>}
    </>
  );
}
