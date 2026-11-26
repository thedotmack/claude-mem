import React, { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { XIcon } from './icons';

const DISMISSED_KEY = 'claude-mem-timeline-cloud-sync-gift-v1';

export function useTimelineGiftDismissal() {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISSED_KEY) === 'true'; }
    catch { return false; }
  });

  useEffect(() => {
    const syncDismissal = (event: StorageEvent) => {
      if (event.key === DISMISSED_KEY && event.newValue === 'true') setDismissed(true);
    };
    window.addEventListener('storage', syncDismissal);
    return () => window.removeEventListener('storage', syncDismissal);
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISSED_KEY, 'true'); }
    catch { /* Dismissal still lasts for this visit when storage is unavailable. */ }
  };
  return { dismissed, dismiss };
}

/** A viewer-only offer. Its content never becomes a row in the memory feed. */
export function TimelineGift({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <aside className="timeline-gift" aria-labelledby="timeline-gift-title">
      <div>
        <h3 id="timeline-gift-title"><span aria-hidden="true">🎁 </span>{t('A gift for Claude-Mem users')}</h3>
        <p>{t('Check Claude’s latest fix from your phone. Get 30 free days of Cloud Sync and the remote Work Viewer. No credit card required.')}</p>
        <a href="https://cmem.ai/sync?utm_source=timeline_gift&utm_campaign=holiday_cloud_sync" target="_blank" rel="noopener noreferrer">cmem.ai/sync</a>
      </div>
      <button type="button" className="timeline-gift-dismiss" onClick={onDismiss} aria-label={t('Dismiss the Cloud Sync offer')}>
        <XIcon size={18} />
      </button>
    </aside>
  );
}
