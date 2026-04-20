/**
 * Server Middleware - Re-exports and enhances existing middleware
 *
 * This module provides a unified interface for server middleware.
 * Re-exports from worker/http/middleware.ts to maintain backward compatibility
 * while providing a cleaner import path for server setup.
 */

// Re-export all middleware from the existing location
export {
  createMiddleware,
  requireLocalhost,
  summarizeRequestBody
} from '../worker/http/middleware.js';
