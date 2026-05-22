import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { I18nProvider } from './i18n/I18nContext';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

const root = createRoot(container);
root.render(
  <I18nProvider><ErrorBoundary><App /></ErrorBoundary></I18nProvider>
);
