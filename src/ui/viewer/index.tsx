import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';  // React Flow base styles (required for nodes/edges to render)
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

const root = createRoot(container);
root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
