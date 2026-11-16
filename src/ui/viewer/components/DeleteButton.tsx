import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { useI18n, interpolate } from '../../i18n';
import { translateViewerError } from '../../i18n/errors';
import type { DeletableItemType } from '../utils/feed-deletion';
import { DELETE_STAGE_STATUS, useFeedItemDelete, type FeedItemDeletion } from '../hooks/useFeedItemDelete';
import { InlineConfirm } from './InlineConfirm';
import { TrashIcon } from './icons';

interface DeleteButtonProps {
  itemType: DeletableItemType;
  id: number;
  onDeleted: (itemType: DeletableItemType, id: number) => void;
}

export const DELETE_ITEM_LABELS: Record<DeletableItemType, string> = {
  observation: 'observation',
  summary: 'session summary',
};

/**
 * The in-page question, the pending state and a failed delete's reason for one
 * card. A delete that did not finish (refused because it was synced from another
 * device, cloud sync unavailable, worker down, no answer, or stopped by the reader)
 * stays on the card with Try again and Dismiss, never failing silently.
 */
export function DeleteConfirmation({ itemType, deletion, returnFocus }: {
  itemType: DeletableItemType;
  deletion: FeedItemDeletion;
  /** Where focus goes when the question is cancelled or the reason dismissed. */
  returnFocus?: () => void;
}) {
  const { t } = useI18n();
  const item = t(DELETE_ITEM_LABELS[itemType]);
  const retryRef = useRef<HTMLButtonElement>(null);
  const cancel = () => {
    // Cancel before the delete was sent leaves the question; after, the card says it stopped waiting.
    if (deletion.stage === 'asking') returnFocus?.();
    deletion.cancel();
  };
  const dismiss = () => { deletion.dismiss(); returnFocus?.(); };
  // The question's buttons go away when the delete fails; keep keyboard focus on the card.
  useLayoutEffect(() => {
    if (deletion.stage === 'failed' && (document.activeElement === document.body || document.activeElement === null)) {
      retryRef.current?.focus({ preventScroll: true });
    }
  }, [deletion.stage]);
  return (
    <>
      <span className="visually-hidden" role="status">{DELETE_STAGE_STATUS[deletion.stage] && t(DELETE_STAGE_STATUS[deletion.stage])}</span>
      {(deletion.stage === 'asking' || deletion.stage === 'deleting') && (
        <InlineConfirm
          question={interpolate(t('Delete this {item}? This cannot be undone.'), { item })}
          confirmLabel={t('Delete')}
          busyLabel={t('Deleting…')}
          busy={deletion.stage === 'deleting'}
          onConfirm={deletion.confirm}
          onCancel={cancel}
        />
      )}
      {deletion.stage === 'failed' && deletion.failure && (
        <div className="card-delete-error" role="alert" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(); } }}>
          <span>{translateViewerError(deletion.failure, t)}</span>
          <button ref={retryRef} type="button" className="link-button" onClick={deletion.retry}>{t('Try again')}</button>
          <button type="button" className="link-button" onClick={dismiss}>{t('Dismiss')}</button>
        </div>
      )}
    </>
  );
}

/** A bin that turns red under the pointer and asks in place on the card before deleting. */
export function DeleteButton({ itemType, id, onDeleted }: DeleteButtonProps) {
  const { t } = useI18n();
  const deletion = useFeedItemDelete(itemType, id, onDeleted);
  const binRef = useRef<HTMLButtonElement>(null);
  const refocusBin = useRef(false);
  useEffect(() => {
    if (deletion.stage === 'idle' && refocusBin.current) { refocusBin.current = false; binRef.current?.focus(); }
  }, [deletion.stage]);
  const actionTitle = interpolate(t('Delete {item}'), { item: t(DELETE_ITEM_LABELS[itemType]) });
  if (deletion.stage !== 'idle') {
    return <DeleteConfirmation itemType={itemType} deletion={deletion} returnFocus={() => { refocusBin.current = true; }} />;
  }
  return (
    <button ref={binRef} type="button" className="card-delete-btn" onClick={deletion.ask} title={actionTitle} aria-label={actionTitle}>
      <TrashIcon size={14} />
    </button>
  );
}
