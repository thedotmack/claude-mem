import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { WorkerAuthGate } from './components/WorkerAuthGate';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

const root = createRoot(container);
root.render(
  <ErrorBoundary>
    <WorkerAuthGate>
      <App />
    </WorkerAuthGate>
  </ErrorBoundary>
);
