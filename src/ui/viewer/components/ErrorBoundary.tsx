import React, { Component, ReactNode, ErrorInfo } from 'react';
import { t } from '../../i18n';
import { formatDate } from '../utils/formatters';
import { CopyButton } from './CopyButton';
import { WarningIcon } from './icons';

interface Props {
  children: ReactNode;
  /**
   * Draws a minimal header (My Work and the logo) with the card. The outermost
   * boundary needs it, because a crash there takes the real header down with it;
   * the boundary inside the page leaves the real header on screen.
   */
  withHeader?: boolean;
  /** A new key (another view or session) gives the content a fresh try. */
  resetKey?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  failedAt: number | null;
}

/**
 * One card that says the viewer stopped while drawing and that saved memories
 * are safe, with "Reload the viewer", "Open My Work" and the raw cause folded
 * under "Error details" in monospace with Copy details (G17: plain words first,
 * the raw cause only in the fold). It follows the viewer's theme tokens.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, failedAt: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error, failedAt: Date.now() };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    this.setState({ error, errorInfo });
  }

  componentDidUpdate(previous: Props) {
    if (this.state.hasError && previous.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null, errorInfo: null, failedAt: null });
    }
  }

  /** The raw cause, for the fold and for Copy details: when it stopped, the error, and where in the page. */
  private details(): string {
    const { error, errorInfo, failedAt } = this.state;
    return [failedAt !== null ? formatDate(failedAt) : '', error?.toString() ?? '', errorInfo?.componentStack?.trim() ?? '']
      .filter(Boolean).join('\n\n');
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    const card = (
      <main className="viewer-error-page" aria-labelledby="viewer-error-title">
        <section className="viewer-error-card">
          <p className="viewer-error-eyebrow"><WarningIcon size={18} />{t('The viewer stopped')}</p>
          <h2 id="viewer-error-title">{t('Something went wrong while showing your memories')}</h2>
          <p className="viewer-error-body">{t('Your saved memories are safe. This page hit an error while drawing the list.')}</p>
          <div className="viewer-error-actions">
            <button type="button" className="btn-primary" onClick={() => window.location.reload()}>{t('Reload the viewer')}</button>
            <a className="button-link" href="/">{t('Open My Work')}</a>
          </div>
          <div className="viewer-error-details-row">
            <details className="viewer-error-details">
              <summary>{t('Error details')}</summary>
              <pre>{this.details()}</pre>
            </details>
            <CopyButton label={t('Copy details')} text={() => this.details()} className="viewer-error-copy" />
          </div>
        </section>
      </main>
    );
    if (!this.props.withHeader) return card;
    return (
      <>
        <header className="header">
          <a href="/" className="local-work-link">{t('My Work')}</a>
          <h1 className="header-logo">
            <span className="logomark-wrap"><img src="claude-mem-logomark.webp" alt="" className="logomark" /></span>
            <span className="logo-text">claude-mem</span>
          </h1>
        </header>
        {card}
      </>
    );
  }
}
