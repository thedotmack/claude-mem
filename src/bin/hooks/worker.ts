#!/usr/bin/env node

/**
 * Worker Entry Point
 * Standalone background process for SDK agent
 */

import { main } from '../../sdk/worker.js';

// Entry point - just call the worker main function
main().catch((error) => {
  console.error('[SDK Worker] Fatal error:', error);
  process.exit(1);
});
