import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  getStoredWelcomeDismissed,
  setStoredWelcomeDismissed,
} from '../../src/ui/viewer/components/WelcomeCard';

const data = new Map<string, string>();
const memStore = {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => { data.set(key, value); },
  removeItem: (key: string) => { data.delete(key); },
};
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memStore });
afterAll(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

const STORAGE_KEY = 'claude-mem-welcome-dismissed-v3';
const LEGACY_KEY = 'claude-mem-welcome-dismissed-v2';

describe('WelcomeCard storage helpers (v3 key)', () => {
  beforeEach(() => { data.clear(); });

  it('round-trips dismissal through the v3 key', () => {
    expect(getStoredWelcomeDismissed()).toBe(false);
    setStoredWelcomeDismissed(true);
    expect(memStore.getItem(STORAGE_KEY)).toBe('true');
    expect(getStoredWelcomeDismissed()).toBe(true);
    setStoredWelcomeDismissed(false);
    expect(memStore.getItem(STORAGE_KEY)).toBeNull();
    expect(getStoredWelcomeDismissed()).toBe(false);
  });

  it('does not consult the v2 legacy key', () => {
    memStore.setItem(LEGACY_KEY, 'true');
    expect(getStoredWelcomeDismissed()).toBe(false);
  });
});
