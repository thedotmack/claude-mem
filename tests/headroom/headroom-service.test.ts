import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { HeadroomService } from '../../src/services/headroom/HeadroomService.js';

/**
 * Settings injection: HeadroomService reads settings via
 * SettingsDefaultsManager.loadFromFile(paths.settings()), which applies
 * applyEnvOverrides by default — process.env.CLAUDE_MEM_HEADROOM_* wins over
 * settings.json, so tests configure the service through the environment
 * (same route as the rest of the suite; data dir is pinned by tests/preload.ts).
 */

/** Port with nothing listening — connection refused, exercising fallback: true. */
const UNREACHABLE_HEADROOM_URL = 'http://127.0.0.1:59999';

const savedHeadroomEnabled = process.env.CLAUDE_MEM_HEADROOM_ENABLED;
const savedHeadroomUrl = process.env.CLAUDE_MEM_HEADROOM_URL;

function restoreEnv(key: string, savedValue: string | undefined): void {
  if (savedValue === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = savedValue;
  }
}

describe('HeadroomService', () => {
  afterEach(() => {
    restoreEnv('CLAUDE_MEM_HEADROOM_ENABLED', savedHeadroomEnabled);
    restoreEnv('CLAUDE_MEM_HEADROOM_URL', savedHeadroomUrl);
  });

  describe('compressPayload with CLAUDE_MEM_HEADROOM_ENABLED=false', () => {
    let tripwireServer: Server;
    let tripwireHits = 0;

    beforeEach(async () => {
      tripwireHits = 0;
      tripwireServer = createServer((req, res) => {
        tripwireHits++;
        res.end('{}');
      });
      await new Promise<void>(resolve => tripwireServer.listen(0, '127.0.0.1', resolve));
    });

    afterEach(async () => {
      await new Promise<void>(resolve => tripwireServer.close(() => resolve()));
    });

    it('should return null without making any network call', async () => {
      const tripwirePort = (tripwireServer.address() as AddressInfo).port;
      process.env.CLAUDE_MEM_HEADROOM_ENABLED = 'false';
      // Point at a live listener that records hits — any request fails the test.
      process.env.CLAUDE_MEM_HEADROOM_URL = `http://127.0.0.1:${tripwirePort}`;

      const result = await HeadroomService.getInstance().compressPayload([
        { role: 'user', content: 'hello' },
      ]);

      expect(result).toBeNull();
      expect(tripwireHits).toBe(0);
    });
  });

  describe('compressPayload with CLAUDE_MEM_HEADROOM_ENABLED=true and an unreachable proxy', () => {
    it('should resolve to the fallback result (original messages, compressed: false) within ~3s', async () => {
      process.env.CLAUDE_MEM_HEADROOM_ENABLED = 'true';
      process.env.CLAUDE_MEM_HEADROOM_URL = UNREACHABLE_HEADROOM_URL;

      const originalMessages = [{ role: 'user', content: 'compress me please' }];
      const startedAt = Date.now();

      const result = await HeadroomService.getInstance().compressPayload(originalMessages, 5000);
      const elapsedMs = Date.now() - startedAt;

      expect(result).not.toBeNull();
      expect(result!.compressed).toBe(false);
      expect(result!.messages).toEqual(originalMessages);
      expect(result!.tokensSaved).toBe(0);
      expect(result!.ccrHashes).toEqual([]);
      expect(elapsedMs).toBeLessThan(3000);
    }, 10000);
  });

  describe('getInstance', () => {
    it('should return the same lazy singleton instance', () => {
      expect(HeadroomService.getInstance()).toBe(HeadroomService.getInstance());
    });
  });
});
