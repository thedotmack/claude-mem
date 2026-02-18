import type { ReactNode, ErrorInfo } from 'react';
import React, { Component } from 'react';
import { logger } from '../utils/logger';

/** Show error details only when explicitly enabled via localStorage. */
function isDebugEnabled(): boolean {
  try {
    return localStorage.getItem('viewer-log-level') === 'debug';
  } catch {
    return false;
  }
}

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
    logger.error('ErrorBoundary', error.message);
    this.setState({
      error,
      errorInfo
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <h1 className="error-boundary__title">Something went wrong</h1>
          <p className="error-boundary__message">
            The application encountered an error. Please refresh the page to try again.
          </p>
          {this.state.error && isDebugEnabled() && (
            <details className="error-boundary__details">
              <summary className="error-boundary__summary">Error details</summary>
              <pre className="error-boundary__stack">
                {this.state.error.message}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
