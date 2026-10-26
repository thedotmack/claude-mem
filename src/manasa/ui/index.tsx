// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { installBrowserFallbackIfNeeded } from './browser-runtime.js';

installBrowserFallbackIfNeeded();

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
