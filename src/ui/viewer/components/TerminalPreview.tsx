import React, { useMemo, useRef, useLayoutEffect, useState } from 'react';
import AnsiToHtml from 'ansi-to-html';
import DOMPurify from 'dompurify';
import { useI18n } from '../../i18n';
import { previewFacts, type PreviewShortening } from '../utils/settings-preview';
import { CopyButton } from './CopyButton';
import { InfoIcon } from './icons';

interface TerminalPreviewProps {
  content: string;
  isLoading?: boolean;
  className?: string;
  /** What the preview shows, e.g. "claude · my-project", on the strip above the text. */
  label?: string;
  /** Shown with the shortened note: opens everything the preview left out somewhere it can all be read. */
  onShowAll?: () => void;
}

/**
 * The preview's colours are the viewer's theme tokens, so it follows light and dark. The worker writes the
 * human preview with these ANSI colours (src/services/context/types.ts): cyan day headings, yellow summary
 * rows, magenta "Previously", red warnings, gray and dim details. On the preview's well (--color-bg-primary)
 * each token below is held to 4.5:1 in both themes by tests/viewer/viewer-token-contrast.test.ts (the log
 * tokens are the logs drawer's terminal palette) and by tests/viewer/settings-dialog.test.ts.
 */
const ANSI_THEME_COLOURS: Record<number, string> = {
  0: 'var(--color-text-primary)', 1: 'var(--color-log-error)', 2: 'var(--color-log-success)', 3: 'var(--color-log-warn)',
  4: 'var(--color-log-info)', 5: 'var(--color-log-component)', 6: 'var(--color-accent-primary)', 7: 'var(--color-text-primary)',
  8: 'var(--color-text-secondary)', 9: 'var(--color-log-error)', 10: 'var(--color-log-success)', 11: 'var(--color-log-warn)',
  12: 'var(--color-log-info)', 13: 'var(--color-log-component)', 14: 'var(--color-accent-primary)', 15: 'var(--color-text-primary)',
};

const ansiConverter = new AnsiToHtml({
  fg: 'var(--color-text-primary)',
  bg: 'var(--color-bg-primary)',
  colors: ANSI_THEME_COLOURS,
  newline: false,
  escapeXML: true,
  stream: false,
});

/** The line under a shortened preview, by how the worker shortened it. */
const SHORTENED_WORDS: Record<PreviewShortening, (t: (english: string) => string) => string> = {
  observations: t => t('Preview shortened. The model receives the full context; older observations are not shown here.'),
  text: t => t('Preview shortened. The model receives the full context; some text is not shown here.'),
};

export function TerminalPreview({ content, isLoading = false, className = '', label, onShowAll }: TerminalPreviewProps) {
  const { t } = useI18n();
  const preRef = useRef<HTMLPreElement>(null);
  const scrollTopRef = useRef(0);
  const [wordWrap, setWordWrap] = useState(true);
  const facts = useMemo(() => previewFacts(content), [content]);

  const html = useMemo(() => {
    if (preRef.current) {
      scrollTopRef.current = preRef.current.scrollTop;
    }
    if (!facts.body) return '';
    const convertedHtml = ansiConverter.toHtml(facts.body);
    return DOMPurify.sanitize(convertedHtml, {
      // <b> is the converter's bold (the worker's "bright" day headings and titles).
      ALLOWED_TAGS: ['span', 'div', 'br', 'b'],
      ALLOWED_ATTR: ['style', 'class'],
      ALLOW_DATA_ATTR: false
    });
  }, [facts.body]);

  useLayoutEffect(() => {
    if (preRef.current && scrollTopRef.current > 0) {
      preRef.current.scrollTop = scrollTopRef.current;
    }
  }, [html]);

  return (
    <div className={`terminal-preview${className ? ` ${className}` : ''}`}>
      <div className="terminal-strip">
        <span className="terminal-strip-label">{label}</span>
        <span className="terminal-strip-actions">
          <button type="button" className="terminal-strip-btn" aria-pressed={wordWrap} onClick={() => setWordWrap(!wordWrap)}>
            {t('Wrap lines')}
          </button>
          <CopyButton text={() => facts.plainText} label={t('Copy')} className="terminal-strip-btn" />
        </span>
      </div>

      {isLoading ? (
        <div className="terminal-loading">{t('Loading preview...')}</div>
      ) : (
        <div className="terminal-body">
          {/* Focusable so the keyboard can scroll it; named so a screen reader says what it is. */}
          <pre
            ref={preRef}
            className={`terminal-text${wordWrap ? ' terminal-text--wrap' : ''}`}
            tabIndex={0}
            aria-label={label ? `${t('Saved context preview')}: ${label}` : t('Saved context preview')}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )}

      {!isLoading && facts.shortened && (
        <div className="terminal-note">
          <InfoIcon size={16} />
          <span>{SHORTENED_WORDS[facts.shortened](t)}</span>
          {onShowAll && <button type="button" className="link-button" onClick={onShowAll}>{t('Show all in the timeline')}</button>}
        </div>
      )}
    </div>
  );
}
