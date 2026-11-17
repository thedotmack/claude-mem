import React, { useEffect, useRef } from 'react';
import { useI18n } from '../../i18n';

interface InlineConfirmProps {
  question: string;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  onConfirm: () => void;
  /** Leaves the question; while busy, stops waiting for the action. */
  onCancel: () => void;
}

/**
 * A question asked in place, with Cancel and a red action, instead of the
 * browser's confirm box. Cancel takes focus first so Enter never deletes by
 * accident; Escape cancels. Both keep working while the action runs, so a slow
 * worker never leaves the card stuck.
 */
export function InlineConfirm({ question, confirmLabel, busyLabel, busy, onConfirm, onCancel }: InlineConfirmProps) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return (
    <div
      className="inline-confirm"
      role="group"
      aria-label={question}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}
    >
      <span className="inline-confirm-question">{question}</span>
      <span className="inline-confirm-actions">
        <button ref={cancelRef} type="button" className="inline-confirm-cancel" onClick={onCancel}>{t('Cancel')}</button>
        {/* While busy the button keeps focus (aria-disabled, not disabled) and ignores a second press. */}
        <button type="button" className="inline-confirm-danger" aria-disabled={busy || undefined}
          onClick={() => { if (!busy) onConfirm(); }}>
          {busy ? busyLabel : confirmLabel}
        </button>
      </span>
    </div>
  );
}
