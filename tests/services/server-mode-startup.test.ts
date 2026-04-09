/**
 * Tests for ensureServerModeReady()
 *
 * Verifies the server mode setup logic:
 * - Auto-generate auth token when missing
 * - Change bind address from 127.0.0.1 to 0.0.0.0
 * - No changes when already configured correctly
 * - Other settings fields are preserved
 *
 * Mock Justification (~5% mock code):
 * - LaunchdManager: launchctl is unavailable in CI and non-macOS environments.
 *   The launchd integration is covered by LaunchdManager's own tests.
 *
 * What's NOT mocked: fs operations, randomBytes, JSON parsing — all run for real
 * against a temp directory, exercising the actual logic end-to-end.
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock LaunchdManager to avoid launchctl calls in tests
mock.module('../../src/services/infrastructure/LaunchdManager.js', () => ({
  ensureLaunchdService: mock(() => Promise.resolve()),
  removeLaunchdService: mock(() => {}),
  isServiceLoaded: mock(() => false),
  generatePlist: mock(() => ''),
}));

// Import after mocks
import { logger } from '../../src/utils/logger.js';
import { ensureServerModeReady } from '../../src/services/infrastructure/ServerModeSetup.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('ensureServerModeReady', () => {
  let testDir: string;
  let settingsPath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `claude-mem-server-mode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    settingsPath = join(testDir, 'settings.json');

    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('auth token generation', () => {
    it('should generate a 64-char hex token when CLAUDE_MEM_AUTH_TOKEN is empty', async () => {
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_AUTH_TOKEN: '',
        CLAUDE_MEM_WORKER_HOST: '0.0.0.0',
      }), 'utf-8');

      await ensureServerModeReady(settingsPath);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.CLAUDE_MEM_AUTH_TOKEN).toBeTruthy();
      expect(settings.CLAUDE_MEM_AUTH_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should generate a token when CLAUDE_MEM_AUTH_TOKEN key is absent', async () => {
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_WORKER_HOST: '0.0.0.0',
      }), 'utf-8');

      await ensureServerModeReady(settingsPath);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.CLAUDE_MEM_AUTH_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should NOT overwrite an existing auth token', async () => {
      const existingToken = 'my-existing-secret-token-do-not-change';
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_AUTH_TOKEN: existingToken,
        CLAUDE_MEM_WORKER_HOST: '0.0.0.0',
      }), 'utf-8');

      await ensureServerModeReady(settingsPath);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.CLAUDE_MEM_AUTH_TOKEN).toBe(existingToken);
    });

    it('should generate different tokens on two separate calls with empty tokens', async () => {
      const settingsPath2 = join(testDir, 'settings2.json');
      writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_AUTH_TOKEN: '', CLAUDE_MEM_WORKER_HOST: '0.0.0.0' }), 'utf-8');
      writeFileSync(settingsPath2, JSON.stringify({ CLAUDE_MEM_AUTH_TOKEN: '', CLAUDE_MEM_WORKER_HOST: '0.0.0.0' }), 'utf-8');

      await ensureServerModeReady(settingsPath);
      await ensureServerModeReady(settingsPath2);

      const s1 = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const s2 = JSON.parse(readFileSync(settingsPath2, 'utf-8'));
      // randomBytes(32) → 64 hex chars; collision probability is astronomically low
      expect(s1.CLAUDE_MEM_AUTH_TOKEN).not.toBe(s2.CLAUDE_MEM_AUTH_TOKEN);
    });
  });

  describe('bind address', () => {
    it('should change CLAUDE_MEM_WORKER_HOST from 127.0.0.1 to 0.0.0.0', async () => {
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_AUTH_TOKEN: 'existing-token',
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      }), 'utf-8');

      await ensureServerModeReady(settingsPath);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.CLAUDE_MEM_WORKER_HOST).toBe('0.0.0.0');
    });

    it('should set CLAUDE_MEM_WORKER_HOST to 0.0.0.0 when key is absent', async () => {
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_AUTH_TOKEN: 'existing-token',
      }), 'utf-8');

      await ensureServerModeReady(settingsPath);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.CLAUDE_MEM_WORKER_HOST).toBe('0.0.0.0');
    });

    it('should NOT change CLAUDE_MEM_WORKER_HOST when already 0.0.0.0', async () => {
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_AUTH_TOKEN: 'existing-token',
        CLAUDE_MEM_WORKER_HOST: '0.0.0.0',
      }), 'utf-8');

      await ensureServerModeReady(settingsPath);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.CLAUDE_MEM_WORKER_HOST).toBe('0.0.0.0');
    });

    it('should NOT change a custom non-localhost bind address', async () => {
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_AUTH_TOKEN: 'existing-token',
        CLAUDE_MEM_WORKER_HOST: '192.168.1.100',
      }), 'utf-8');

      await ensureServerModeReady(settingsPath);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      // A non-localhost address that isn't 127.0.0.1 should be preserved
      expect(settings.CLAUDE_MEM_WORKER_HOST).toBe('192.168.1.100');
    });
  });

  describe('no-op when already configured', () => {
    it('should not rewrite the file when token and host are already correct', async () => {
      const initialContent = JSON.stringify({
        CLAUDE_MEM_AUTH_TOKEN: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        CLAUDE_MEM_WORKER_HOST: '0.0.0.0',
      });
      writeFileSync(settingsPath, initialContent, 'utf-8');

      const mtimeBefore = statSync(settingsPath).mtimeMs;

      // Small delay to ensure mtime would differ if file is rewritten
      await new Promise(r => setTimeout(r, 20));

      await ensureServerModeReady(settingsPath);

      const mtimeAfter = statSync(settingsPath).mtimeMs;
      // File should not have been rewritten (mtime unchanged)
      expect(mtimeAfter).toBe(mtimeBefore);
    });
  });

  describe('settings persistence', () => {
    it('should preserve other settings fields when writing changes', async () => {
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_AUTH_TOKEN: '',
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
        CLAUDE_MEM_WORKER_PORT: '37777',
        CLAUDE_MEM_LOG_LEVEL: 'DEBUG',
        CLAUDE_MEM_NODE_NAME: 'my-server',
      }), 'utf-8');

      await ensureServerModeReady(settingsPath);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      // Changed fields
      expect(settings.CLAUDE_MEM_WORKER_HOST).toBe('0.0.0.0');
      expect(settings.CLAUDE_MEM_AUTH_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      // Untouched fields preserved
      expect(settings.CLAUDE_MEM_WORKER_PORT).toBe('37777');
      expect(settings.CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG');
      expect(settings.CLAUDE_MEM_NODE_NAME).toBe('my-server');
    });

    it('should write valid JSON to settings file after changes', async () => {
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_AUTH_TOKEN: '',
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      }), 'utf-8');

      await ensureServerModeReady(settingsPath);

      // Should not throw on parse
      const content = readFileSync(settingsPath, 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();
    });
  });
});
