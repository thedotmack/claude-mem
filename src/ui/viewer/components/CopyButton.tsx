import React, { useState } from 'react';
import { useI18n } from '../../i18n';
import { copyText } from '../utils/clipboard';
import { CopyIcon } from './icons';

/** What a copy control says after it is pressed. One writer: useCopy. Cleared when focus leaves the control. */
type CopyState = 'idle' | 'copied' | 'failed';
const COPY_RESULT_WORDS: Record<CopyState, string | null> = {
  idle: null,
  copied: 'Copied',
  failed: 'Copy failed',
};

function useCopy(text: () => string) {
  const [state, setState] = useState<CopyState>('idle');
  return {
    state,
    words: COPY_RESULT_WORDS[state],
    copy: async () => {
      const failure = await copyText(text());
      // The control says "Copy failed"; the console keeps why (the browser's own error is the cause).
      if (failure) console.warn('[viewer] Copy failed:', failure, failure.cause);
      setState(failure ? 'failed' : 'copied');
    },
    reset: () => setState('idle'),
  };
}

/** A worded Copy button; it reads "Copied" (or "Copy failed") until focus or the pointer leaves it. */
export function CopyButton({ text, label, className = 'link-button' }: { text: () => string; label: string; className?: string }) {
  const { t } = useI18n();
  const copy = useCopy(text);
  return (
    <button type="button" className={`copy-button ${className}`.trim()} onClick={copy.copy} onBlur={copy.reset} onMouseLeave={copy.reset}>
      <CopyIcon size={14} />
      <span aria-live="polite">{copy.words ? t(copy.words) : label}</span>
    </button>
  );
}

/** A menu item that copies and stays open, so its "Copied" can be read. */
export function CopyMenuItem({ text, label }: { text: () => string; label: string }) {
  const { t } = useI18n();
  const copy = useCopy(text);
  return (
    <button type="button" role="menuitem" tabIndex={-1} className="menu-item" onClick={copy.copy} onBlur={copy.reset}>
      <span className="menu-item-icon" aria-hidden="true"><CopyIcon size={16} /></span>
      <span className="menu-item-label" aria-live="polite">{copy.words ? t(copy.words) : label}</span>
    </button>
  );
}
