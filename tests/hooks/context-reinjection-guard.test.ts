/**
 * Tests for Context Re-Injection Guard (#1079)
 *
 * Validates:
 * - session-init handler skips SDK agent init when contextInjected=true
 * - session-init handler proceeds with SDK agent init when contextInjected=false
 * - SessionManager.getSession returns undefined for uninitialized sessions
 * - SessionManager.getSession returns session after initialization
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

// Mock modules that cause import chain issues - MUST be before handler imports
// paths.ts calls SettingsDefaultsManager.get() at module load time
mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: [] }),
  },
}));

mock.module('../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(true),
  getWorkerPort: () => 37777,
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectName: () => 'test-project',
}));

mock.module('../../src/utils/project-filter.js', () => ({
  isProjectExcluded: () => false,
}));

// Now import after mocks
import { logger } from '../../src/utils/logger.js';

// Suppress logger output during tests
let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
});

describe('Context Re-Injection Guard (#1079)', () => {
  describe('session-init handler - contextInjected flag behavior', () => {
    it('should skip SDK agent init when contextInjected is true', async () => {
      const fetchedUrls: string[] = [];

      const mockFetch = mock((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        fetchedUrls.push(urlStr);

        if (urlStr.includes('/api/sessions/init')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              sessionDbId: 42,
              promptNumber: 2,
              skipped: false,
              contextInjected: true  // SDK agent already running
            })
          });
        }

        // The /sessions/42/init call — should NOT be reached
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'initialized' })
        });
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as any;

      try {
        const { sessionInitHandler } = await import('../../src/cli/handlers/session-init.js');

        const result = await sessionInitHandler.execute({
          sessionId: 'test-session-123',
          cwd: '/test/project',
          prompt: 'second prompt in this session',
          platform: 'claude-code',
        });

        // Should return success without making the second /sessions/42/init call
        expect(result.continue).toBe(true);
        expect(result.suppressOutput).toBe(true);

        // Only the /api/sessions/init call should have been made
        const apiInitCalls = fetchedUrls.filter(u => u.includes('/api/sessions/init'));
        const sdkInitCalls = fetchedUrls.filter(u => u.includes('/sessions/42/init'));

        expect(apiInitCalls.length).toBe(1);
        expect(sdkInitCalls.length).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should proceed with SDK agent init when contextInjected is false', async () => {
      const fetchedUrls: string[] = [];

      const mockFetch = mock((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        fetchedUrls.push(urlStr);

        if (urlStr.includes('/api/sessions/init')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              sessionDbId: 42,
              promptNumber: 1,
              skipped: false,
              contextInjected: false  // First prompt — SDK agent not yet started
            })
          });
        }

        // The /sessions/42/init call — SHOULD be reached
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'initialized' })
        });
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as any;

      try {
        const { sessionInitHandler } = await import('../../src/cli/handlers/session-init.js');

        const result = await sessionInitHandler.execute({
          sessionId: 'test-session-456',
          cwd: '/test/project',
          prompt: 'first prompt in session',
          platform: 'claude-code',
        });

        expect(result.continue).toBe(true);
        expect(result.suppressOutput).toBe(true);

        // Both calls should have been made
        const apiInitCalls = fetchedUrls.filter(u => u.includes('/api/sessions/init'));
        const sdkInitCalls = fetchedUrls.filter(u => u.includes('/sessions/42/init'));

        expect(apiInitCalls.length).toBe(1);
        expect(sdkInitCalls.length).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should proceed with SDK agent init when contextInjected is undefined (backward compat)', async () => {
      const fetchedUrls: string[] = [];

      const mockFetch = mock((url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        fetchedUrls.push(urlStr);

        if (urlStr.includes('/api/sessions/init')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              sessionDbId: 42,
              promptNumber: 1,
              skipped: false
              // contextInjected not present (older worker version)
            })
          });
        }

        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'initialized' })
        });
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as any;

      try {
        const { sessionInitHandler } = await import('../../src/cli/handlers/session-init.js');

        const result = await sessionInitHandler.execute({
          sessionId: 'test-session-789',
          cwd: '/test/project',
          prompt: 'test prompt',
          platform: 'claude-code',
        });

        expect(result.continue).toBe(true);

        // When contextInjected is undefined/missing, should still make the SDK init call
        const sdkInitCalls = fetchedUrls.filter(u => u.includes('/sessions/42/init'));
        expect(sdkInitCalls.length).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('SessionManager contextInjected logic', () => {
    it('should return undefined for getSession when no active session exists', async () => {
      const { SessionManager } = await import('../../src/services/worker/SessionManager.js');

      const mockDbManager = {
        getSessionById: () => ({
          id: 1,
          content_session_id: 'test-session',
          project: 'test',
          user_prompt: 'test prompt',
          memory_session_id: null,
          status: 'active',
          started_at: new Date().toISOString(),
          completed_at: null,
        }),
        getSessionStore: () => ({ db: {} }),
      } as any;

      const sessionManager = new SessionManager(mockDbManager);

      // Session 42 has not been initialized in memory
      const session = sessionManager.getSession(42);
      expect(session).toBeUndefined();
    });

    it('should return active session after initializeSession is called', async () => {
      const { SessionManager } = await import('../../src/services/worker/SessionManager.js');

      const mockDbManager = {
        getSessionById: () => ({
          id: 42,
          content_session_id: 'test-session',
          project: 'test',
          user_prompt: 'test prompt',
          memory_session_id: null,
          status: 'active',
          started_at: new Date().toISOString(),
          completed_at: null,
        }),
        getSessionStore: () => ({
          db: {},
          clearMemorySessionId: () => {},
        }),
      } as any;

      const sessionManager = new SessionManager(mockDbManager);

      // Initialize session (simulates first SDK agent init)
      sessionManager.initializeSession(42, 'first prompt', 1);

      // Now getSession should return the active session
      const session = sessionManager.getSession(42);
      expect(session).toBeDefined();
      expect(session!.contentSessionId).toBe('test-session');
    });

    it('should return contextInjected=true pattern for subsequent prompts', async () => {
      const { SessionManager } = await import('../../src/services/worker/SessionManager.js');

      const mockDbManager = {
        getSessionById: () => ({
          id: 42,
          content_session_id: 'test-session',
          project: 'test',
          user_prompt: 'test prompt',
          memory_session_id: 'sdk-session-abc',
          status: 'active',
          started_at: new Date().toISOString(),
          completed_at: null,
        }),
        getSessionStore: () => ({
          db: {},
          clearMemorySessionId: () => {},
        }),
      } as any;

      const sessionManager = new SessionManager(mockDbManager);

      // Before initialization: contextInjected would be false
      expect(sessionManager.getSession(42)).toBeUndefined();

      // After initialization: contextInjected would be true
      sessionManager.initializeSession(42, 'first prompt', 1);
      expect(sessionManager.getSession(42)).toBeDefined();

      // Second call to initializeSession returns existing session (idempotent)
      const session2 = sessionManager.initializeSession(42, 'second prompt', 2);
      expect(session2.contentSessionId).toBe('test-session');
      expect(session2.userPrompt).toBe('second prompt');
      expect(session2.lastPromptNumber).toBe(2);
    });
  });
});
