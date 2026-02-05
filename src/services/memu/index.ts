/**
 * memU Module
 *
 * Primary storage layer for claude-memu.
 * Supports two modes:
 * - API mode: Uses memU cloud/self-hosted API (requires CLAUDE_MEMU_API_KEY)
 * - Local mode: File-based JSON storage (no API key required)
 */

export * from './types.js';
export * from './memu-client.js';
export * from './MemuStore.js';
export * from './LocalStore.js';
export * from './UnifiedStore.js';
export * from './StoreManager.js';

// Re-export UnifiedStore functions as primary interface
export { getStore, initializeStore, resetStore } from './UnifiedStore.js';

// Re-export legacy-compatible stores
export { SessionStore, SessionSearch, PendingMessageStore, ChromaSync, getSessionStore, getSessionSearch, initializeStores } from './StoreManager.js';
