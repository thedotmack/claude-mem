import '../install-local-api-token';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

const root = createRoot(container);
// The page's own boundary keeps a minimal header; App wraps its content in another
// boundary so a drawing error there leaves the real header on screen.
root.render(
  <ErrorBoundary withHeader>
    <App />
  </ErrorBoundary>
);
