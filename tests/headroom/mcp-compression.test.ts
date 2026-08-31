import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  maybeCompressToolResponse,
  headroomRetrieveTool,
  headroomRetrieveToolIfEnabled,
} from '../../src/services/headroom/mcp-compression.js';

/**
 * Settings injection: the helpers read settings via HeadroomService →
 * SettingsDefaultsManager.loadFromFile(paths.settings()), which applies
 * applyEnvOverrides by default — process.env.CLAUDE_MEM_HEADROOM_* wins over
 * settings.json, so tests configure through the environment (same route as
 * tests/headroom/headroom-service.test.ts; data dir pinned by tests/preload.ts).
 */

/** Port with nothing listening — connection refused, exercising fallback: true. */
const UNREACHABLE_HEADROOM_URL = 'http://127.0.0.1:59999';

/** Representative structured payload the MCP search tools return. */
const SAMPLE_PAYLOAD = JSON.stringify(
  {
    content: Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      title: `Observation ${i + 1}`,
      created_at: '2026-08-26T00:00:00.000Z',
    })),
  },
  null,
  2
);

const savedHeadroomEnabled = process.env.CLAUDE_MEM_HEADROOM_ENABLED;
const savedHeadroomUrl = process.env.CLAUDE_MEM_HEADROOM_URL;

function restoreEnv(key: string, savedValue: string | undefined): void {
  if (savedValue === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = savedValue;
  }
}

describe('mcp-compression', () => {
  afterEach(() => {
    restoreEnv('CLAUDE_MEM_HEADROOM_ENABLED', savedHeadroomEnabled);
    restoreEnv('CLAUDE_MEM_HEADROOM_URL', savedHeadroomUrl);
  });

  describe('maybeCompressToolResponse with CLAUDE_MEM_HEADROOM_ENABLED=false', () => {
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

    it('should return the input byte-identical without any network call', async () => {
      const tripwirePort = (tripwireServer.address() as AddressInfo).port;
      process.env.CLAUDE_MEM_HEADROOM_ENABLED = 'false';
      // Point at a live listener that records hits — any request fails the test.
      process.env.CLAUDE_MEM_HEADROOM_URL = `http://127.0.0.1:${tripwirePort}`;

      const result = await maybeCompressToolResponse(SAMPLE_PAYLOAD);

      expect(result).toBe(SAMPLE_PAYLOAD);
      expect(tripwireHits).toBe(0);
    });
  });

  describe('maybeCompressToolResponse with CLAUDE_MEM_HEADROOM_ENABLED=true and an unreachable proxy', () => {
    it('should return the input unchanged (fallback) with no stats line appended', async () => {
      process.env.CLAUDE_MEM_HEADROOM_ENABLED = 'true';
      process.env.CLAUDE_MEM_HEADROOM_URL = UNREACHABLE_HEADROOM_URL;

      const result = await maybeCompressToolResponse(SAMPLE_PAYLOAD);

      expect(result).toBe(SAMPLE_PAYLOAD);
      expect(result).not.toContain('Headroom:');
    }, 10000);
  });

  describe('maybeCompressToolResponse with a healthy proxy', () => {
    let proxyServer: Server;
    let proxyResponse: Record<string, unknown>;

    beforeEach(async () => {
      proxyResponse = {};
      proxyServer = createServer((_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(proxyResponse));
      });
      await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
      const port = (proxyServer.address() as AddressInfo).port;
      process.env.CLAUDE_MEM_HEADROOM_ENABLED = 'true';
      process.env.CLAUDE_MEM_HEADROOM_URL = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      await new Promise<void>(resolve => proxyServer.close(() => resolve()));
    });

    it('should preserve a successful no-op response byte-identically', async () => {
      proxyResponse = {
        messages: [{ role: 'user', content: SAMPLE_PAYLOAD }],
        tokens_before: 100,
        tokens_after: 100,
        tokens_saved: 0,
        compression_ratio: 1,
        transforms_applied: [],
        ccr_hashes: [],
      };

      const result = await maybeCompressToolResponse(SAMPLE_PAYLOAD);

      expect(result).toBe(SAMPLE_PAYLOAD);
      expect(result).not.toContain('Headroom:');
    });

    it('should return compressed text and stats when the proxy reports real savings', async () => {
      proxyResponse = {
        messages: [{ role: 'user', content: 'compressed payload' }],
        tokens_before: 1000,
        tokens_after: 100,
        tokens_saved: 900,
        compression_ratio: 0.1,
        transforms_applied: ['smart_crusher'],
        ccr_hashes: [],
      };

      const result = await maybeCompressToolResponse(SAMPLE_PAYLOAD);

      expect(result).toBe('compressed payload\n\nHeadroom: 1,000t → 100t (900t saved)');
    });
  });

  describe('headroom_retrieve conditional registration', () => {
    it('should be absent when CLAUDE_MEM_HEADROOM_ENABLED=false', () => {
      process.env.CLAUDE_MEM_HEADROOM_ENABLED = 'false';

      expect(headroomRetrieveToolIfEnabled()).toEqual([]);
    });

    it('should be present when CLAUDE_MEM_HEADROOM_ENABLED=true', () => {
      process.env.CLAUDE_MEM_HEADROOM_ENABLED = 'true';

      const registered = headroomRetrieveToolIfEnabled();
      expect(registered).toHaveLength(1);
      expect(registered[0]).toBe(headroomRetrieveTool);
      expect(registered[0].name).toBe('headroom_retrieve');
    });

    it('mcp-server wires the conditional into both tools/list and tools/call dispatch', () => {
      const mcpServerPath = join(import.meta.dir, '..', '..', 'src', 'servers', 'mcp-server.ts');
      const mcpServerSrc = readFileSync(mcpServerPath, 'utf-8');

      const conditionalCallSites = mcpServerSrc.split('...headroomRetrieveToolIfEnabled()').length - 1;
      expect(conditionalCallSites).toBe(2);
      // Registration must stay conditional — never a static entry in the tools array.
      expect(mcpServerSrc).not.toContain("name: 'headroom_retrieve'");
    });

    it('description tells the agent to fall back to get_observations when a hash has expired', () => {
      expect(headroomRetrieveTool.description).toContain('expire');
      expect(headroomRetrieveTool.description).toContain('get_observations([IDs])');
    });

    it('handler rejects when hash is missing (surfaces via the shared tool-error path)', async () => {
      await expect(headroomRetrieveTool.handler({})).rejects.toThrow('"hash" is required');
    });

    it('handler rejects a non-string retrieval query', async () => {
      await expect(headroomRetrieveTool.handler({ hash: 'abc123', query: 42 })).rejects.toThrow('"query" must be a string');
    });

    it('handler answers with a clear disabled message when Headroom is off (defense in depth)', async () => {
      process.env.CLAUDE_MEM_HEADROOM_ENABLED = 'false';

      const result = await headroomRetrieveTool.handler({ hash: 'abc123' });

      expect(result.content[0].text).toContain('Headroom is disabled');
      expect(result.content[0].text).toContain('get_observations([IDs])');
    });

    it('handler degrades a network failure to advisory text instead of an error', async () => {
      process.env.CLAUDE_MEM_HEADROOM_ENABLED = 'true';
      process.env.CLAUDE_MEM_HEADROOM_URL = UNREACHABLE_HEADROOM_URL;

      const result = await headroomRetrieveTool.handler({ hash: 'abc123' });

      expect(result.content[0].text).toContain('abc123');
      expect(result.content[0].text).toContain('get_observations([IDs])');
    }, 10000);
  });
});
