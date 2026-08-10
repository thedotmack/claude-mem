import React, { Component, ReactNode, ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', color: '#ff6b6b', backgroundColor: '#1a1a1a', minHeight: '100vh' }}>
          <h1 style={{ fontSize: '24px', marginBottom: '10px' }}>Something went wrong</h1>
          <p style={{ marginBottom: '10px', color: '#8b949e' }}>
            The application encountered an error. Please refresh the page to try again.
          </p>
          {this.state.error && (
            <details style={{ marginTop: '20px', color: '#8b949e' }}>
              <summary style={{ cursor: 'pointer', marginBottom: '10px' }}>Error details</summary>
              <pre style={{
                backgroundColor: '#0d1117',
                padding: '10px',
                borderRadius: '6px',
                overflow: 'auto'
              }}>
                {this.state.error.toString()}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
