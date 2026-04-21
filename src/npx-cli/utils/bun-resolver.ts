/**
 * Bun binary resolution utility (re-export shim).
 *
 * Actual implementation lives in `src/shared/bun-resolution.ts`.
 * This file preserves the existing `npx-cli` import surface.
 */
export { resolveBunBinaryPath, getBunVersionString } from '../../shared/bun-resolution.js';
