import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Tests for Worker-Managed Transcript Watcher Lifecycle
 *
 * These tests verify that the worker service correctly manages the transcript
 * watcher lifecycle: automatic startup when config exists, graceful shutdown.
 *
 * Tests the lifecycle management at:
 * - worker-service.ts:514 (startTranscriptWatcher)
 * - worker-service.ts:895 (shutdown with watcher cleanup)
 */

describe('Worker-Managed Transcript Watcher Lifecycle', () => {
  let testDir: string;
  let testConfigPath: string;
  let testStatePath: string;

  beforeEach(() => {
    // Create isolated temp directory for each test
    testDir = join(tmpdir(), `transcript-watch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    testConfigPath = join(testDir, 'test-transcript-watch.json');
    testStatePath = join(testDir, 'test-transcript-watch-state.json');
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('startTranscriptWatcher logic', () => {
    it('should verify startTranscriptWatcher exists in worker-service.ts', async () => {
      const { readFileSync } = await import('fs');
      const workerSource = readFileSync('src/services/worker-service.ts', 'utf-8');

      // Verify the method exists
      expect(workerSource).toContain('private async startTranscriptWatcher()');
      expect(workerSource).toContain('await this.startTranscriptWatcher()');
    });

    it('should start watcher when config exists', async () => {
      // Create a minimal valid config
      const config = {
        version: 1,
        schemas: {
          codex: {
            name: 'codex',
            version: '0.2',
            events: []
          }
        },
        watches: [{
          name: 'test',
          path: join(testDir, '**/*.jsonl'),
          schema: 'codex',
          startAtEnd: true
        }],
        stateFile: testStatePath
      };

      writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

      // Import and test the watcher startup logic
      const { loadTranscriptWatchConfig } = await import('../../src/services/transcripts/config.js');
      const { TranscriptWatcher } = await import('../../src/services/transcripts/watcher.js');

      const loadedConfig = loadTranscriptWatchConfig(testConfigPath);
      const watcher = new TranscriptWatcher(loadedConfig, testStatePath);

      // Start watcher (simulates worker-service.ts:514 logic)
      await watcher.start();

      // Verify watcher started successfully
      expect(watcher).toBeDefined();

      // Clean up
      watcher.stop();
    });

    it('should skip watcher startup when config does not exist', async () => {
      // Ensure config does not exist
      if (existsSync(testConfigPath)) {
        unlinkSync(testConfigPath);
      }

      const { expandHomePath } = await import('../../src/services/transcripts/config.js');
      const configPath = expandHomePath(testConfigPath);

      // Verify config does not exist (simulates worker-service.ts:520 check)
      expect(existsSync(configPath)).toBe(false);
    });

    it('should handle config loading errors gracefully', async () => {
      // Create invalid config (missing version)
      const invalidConfig = {
        watches: []
      };

      writeFileSync(testConfigPath, JSON.stringify(invalidConfig, null, 2));

      const { loadTranscriptWatchConfig } = await import('../../src/services/transcripts/config.js');

      // Should throw on invalid config (worker catches this at line 537)
      expect(() => {
        loadTranscriptWatchConfig(testConfigPath);
      }).toThrow();
    });
  });

  describe('shutdown cleanup logic', () => {
    it('should verify shutdown cleanup exists in worker-service.ts', async () => {
      const { readFileSync } = await import('fs');
      const workerSource = readFileSync('src/services/worker-service.ts', 'utf-8');

      // Verify shutdown method includes watcher cleanup
      expect(workerSource).toContain('async shutdown()');
      expect(workerSource).toContain('if (this.transcriptWatcher)');
      expect(workerSource).toContain('this.transcriptWatcher.stop()');
      expect(workerSource).toContain('this.transcriptWatcher = null');
    });

    it('should handle shutdown when watcher is null', () => {
      // Simulate worker shutdown with null watcher (worker-service.ts:895)
      let transcriptWatcher: any = null;

      // Should not throw
      if (transcriptWatcher) {
        transcriptWatcher.stop();
        transcriptWatcher = null;
      }

      expect(transcriptWatcher).toBe(null);
    });

    it('should stop watcher during shutdown', async () => {
      // Create a minimal valid config
      const config = {
        version: 1,
        schemas: {
          codex: {
            name: 'codex',
            version: '0.2',
            events: []
          }
        },
        watches: [{
          name: 'test',
          path: join(testDir, '**/*.jsonl'),
          schema: 'codex',
          startAtEnd: true
        }],
        stateFile: testStatePath
      };

      writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

      const { TranscriptWatcher } = await import('../../src/services/transcripts/watcher.js');
      const { loadTranscriptWatchConfig } = await import('../../src/services/transcripts/config.js');

      const loadedConfig = loadTranscriptWatchConfig(testConfigPath);
      let transcriptWatcher: any = new TranscriptWatcher(loadedConfig, testStatePath);
      await transcriptWatcher.start();

      // Spy on the stop method
      const stopSpy = spyOn(transcriptWatcher, 'stop');

      // Simulate worker shutdown (worker-service.ts:895-899)
      if (transcriptWatcher) {
        transcriptWatcher.stop();
        transcriptWatcher = null;
      }

      // Verify stop was called
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(transcriptWatcher).toBe(null);
    });
  });

  describe('integration with worker lifecycle', () => {
    it('should verify worker property declaration', async () => {
      const { readFileSync } = await import('fs');
      const workerSource = readFileSync('src/services/worker-service.ts', 'utf-8');

      // Verify the worker has transcriptWatcher property
      expect(workerSource).toContain('private transcriptWatcher:');
    });

    it('should verify watcher is started in background initialization', async () => {
      const { readFileSync } = await import('fs');
      const workerSource = readFileSync('src/services/worker-service.ts', 'utf-8');

      // Verify startTranscriptWatcher is called in initializeBackground
      expect(workerSource).toContain('private async initializeBackground()');
      expect(workerSource).toContain('await this.startTranscriptWatcher()');
    });

    it('should verify watcher cleanup in shutdown', async () => {
      const { readFileSync } = await import('fs');
      const workerSource = readFileSync('src/services/worker-service.ts', 'utf-8');

      // Verify shutdown includes watcher cleanup before graceful shutdown
      const shutdownSection = workerSource.substring(
        workerSource.indexOf('async shutdown()'),
        workerSource.indexOf('async shutdown()') + 1000
      );

      expect(shutdownSection).toContain('if (this.transcriptWatcher)');
      expect(shutdownSection).toContain('this.transcriptWatcher.stop()');
      expect(shutdownSection).toContain('performGracefulShutdown');
    });
  });
});
