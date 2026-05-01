import { describe, it, expect, beforeEach } from 'bun:test';

// Simulate a localStorage shim — bun:test runs in node, where window/localStorage
// don't exist. We attach a minimal in-memory store to globalThis before importing
// the helpers, so that the storage helpers exercise the same v2 key path as the
// browser bundle.
class MemoryStorage {
  private data: Map<string, string> = new Map();
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
  get length(): number {
    return this.data.size;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
}

const memStore = new MemoryStorage();
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = memStore;

const STORAGE_KEY = 'claude-mem-welcome-dismissed-v2';
const LEGACY_KEY = 'claude-mem-welcome-dismissed-v1';

// Import after the localStorage shim is in place so the module sees the mock.
import {
  getStoredWelcomeDismissed,
  setStoredWelcomeDismissed,
} from '../../src/ui/viewer/components/WelcomeCard';

describe('WelcomeCard storage helpers (v2 key)', () => {
  beforeEach(() => {
    memStore.clear();
  });

  it('returns false when nothing has been stored', () => {
    expect(getStoredWelcomeDismissed()).toBe(false);
  });

  it('persists dismissal under the v2 key', () => {
    setStoredWelcomeDismissed(true);
    expect(memStore.getItem(STORAGE_KEY)).toBe('true');
    expect(getStoredWelcomeDismissed()).toBe(true);
  });

  it('clears the v2 key when dismissed=false', () => {
    setStoredWelcomeDismissed(true);
    setStoredWelcomeDismissed(false);
    expect(memStore.getItem(STORAGE_KEY)).toBeNull();
    expect(getStoredWelcomeDismissed()).toBe(false);
  });

  it('does not consult the v1 legacy key', () => {
    // A user dismissed the previous (v1) card. The new card must NOT inherit
    // that dismissal — the message and layout are meaningfully different.
    memStore.setItem(LEGACY_KEY, 'true');
    expect(getStoredWelcomeDismissed()).toBe(false);
  });
});
