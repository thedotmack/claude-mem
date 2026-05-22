import React, { Component, ReactNode, ErrorInfo } from 'react';
import { I18nContext } from '../i18n/I18nContext';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    this.setState({
      error,
      errorInfo
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <I18nContext.Consumer>
          {({ t }) => (
            <div style={{ padding: '20px', color: '#ff6b6b', backgroundColor: '#1a1a1a', minHeight: '100vh' }}>
              <h1 style={{ fontSize: '24px', marginBottom: '10px' }}>{t('error.somethingWrong')}</h1>
              <p style={{ marginBottom: '10px', color: '#8b949e' }}>
                {t('error.refreshMessage')}
              </p>
              {this.state.error && (
                <details style={{ marginTop: '20px', color: '#8b949e' }}>
                  <summary style={{ cursor: 'pointer', marginBottom: '10px' }}>{t('error.details')}</summary>
                  <pre style={{
                    backgroundColor: '#0d1117',
                    padding: '10px',
                    borderRadius: '6px',
                    overflow: 'auto'
                  }}>
                    {this.state.error.toString()}
                    {this.state.errorInfo && '\n\n' + this.state.errorInfo.componentStack}
                  </pre>
                </details>
              )}
            </div>
          )}
        </I18nContext.Consumer>
      );
    }
    return this.props.children;
  }
}
