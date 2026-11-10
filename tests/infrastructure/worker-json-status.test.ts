import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import net from 'net';
import path from 'path';
import {
  buildCodexSessionStartOutput,
  buildStatusOutput,
  formatDependencyHealthHint,
} from '../../src/services/worker-service.js';
import { DEPENDENCY_STATUS_LABELS, type DependencyName } from '../../src/shared/dependency-health.js';

const WORKER_SCRIPT = path.join(__dirname, '../../plugin/scripts/worker-service.cjs');

describe('worker-json-status', () => {
  describe('buildStatusOutput', () => {
    describe('Codex SessionStart compatibility', () => {
      it('returns only supported fields when ready', () => {
        const result = buildCodexSessionStartOutput('ready');

        expect(result).toEqual({ continue: true });
        expect(result).not.toHaveProperty('status');
        expect(result).not.toHaveProperty('message');
        expect(result).not.toHaveProperty('suppressOutput');
      });

      it('maps warming state to a fixed systemMessage', () => {
        const result = buildCodexSessionStartOutput('ready', 'raw warming diagnostic');

        expect(result).toEqual({
          continue: true,
          systemMessage: 'claude-mem worker is still warming up.',
        });
        expect(result.systemMessage).not.toContain('raw warming diagnostic');
      });

      it('maps failures to a fixed systemMessage without custom fields', () => {
        const result = buildCodexSessionStartOutput('error', 'raw boot failure diagnostic');

        expect(result).toEqual({
          continue: true,
          systemMessage: 'claude-mem worker failed to start. Run npx claude-mem doctor.',
        });
        expect(result.systemMessage).not.toContain('raw boot failure diagnostic');
        expect(buildCodexSessionStartOutput('error')).toEqual({
          continue: true,
          systemMessage: 'claude-mem worker failed to start. Run npx claude-mem doctor.',
        });
      });
    });

    it('matches the JSON structure for both statuses', () => {
      expect(JSON.parse(JSON.stringify(buildStatusOutput('ready')))).toEqual({
        continue: true,
        suppressOutput: true,
        status: 'ready',
      });
      expect(JSON.parse(JSON.stringify(buildStatusOutput('error', 'error msg')))).toEqual({
        continue: true,
        suppressOutput: true,
        status: 'error',
        message: 'error msg',
      });
    });

    it('omits an empty message', () => {
      expect(buildStatusOutput('error', '')).not.toHaveProperty('message');
    });
  });

  describe('formatDependencyHealthHint', () => {
    it('returns a short dependency degradation hint when health reports degraded dependencies', () => {
      const hint = formatDependencyHealthHint({
        dependencies: {
          degraded: true,
          statuses: [
            {
              dependency: 'claude_cli',
              kind: 'setup_required',
              message: 'Claude executable not found',
              recordedAtMs: 123,
            },
            {
              dependency: 'uvx',
              kind: 'vector_search_unavailable',
              message: 'uvx executable not found',
              recordedAtMs: 124,
            },
            {
              dependency: 'chroma',
              kind: 'vector_search_unavailable',
              message: 'Chroma data dir already has a writer',
              recordedAtMs: 125,
            },
          ],
        },
      });

      expect(hint).toBe('  Dependencies: degraded (Claude CLI setup required, uvx unavailable for vector search, Chroma unavailable for vector search). Run npx claude-mem doctor for remediation.');
    });

    it('words every dependency the worker can report, never its raw identifier', () => {
      for (const [dependency, labels] of Object.entries(DEPENDENCY_STATUS_LABELS)) {
        const hint = formatDependencyHealthHint({
          dependencies: {
            degraded: true,
            statuses: [{ dependency: dependency as DependencyName, kind: labels.kind, message: 'broken', recordedAtMs: 1 }],
          },
        });

        expect(hint).toBe(`  Dependencies: degraded (${labels.statusCommandHint}). Run npx claude-mem doctor for remediation.`);
        expect(hint).not.toContain(`${dependency}: ${labels.kind}`);
      }
    });

    it('names the observer data directory in words', () => {
      const hint = formatDependencyHealthHint({
        dependencies: {
          degraded: true,
          statuses: [{ dependency: 'observer_dir', kind: 'setup_required', message: 'not writable', recordedAtMs: 1 }],
        },
      });

      expect(hint).toContain('Observer data directory setup required');
    });

    it('shows a status from a newer worker under the worker’s own names', () => {
      const hint = formatDependencyHealthHint({
        dependencies: {
          degraded: true,
          statuses: [{ dependency: 'future_dependency', kind: 'future_kind', message: 'broken', recordedAtMs: 1 }],
        },
      } as unknown as Parameters<typeof formatDependencyHealthHint>[0]);

      expect(hint).toContain('future_dependency: future_kind');
    });

    it('returns null when dependencies are healthy or absent', () => {
      expect(formatDependencyHealthHint({})).toBeNull();
      expect(formatDependencyHealthHint({
        dependencies: {
          degraded: false,
          statuses: [],
        },
      })).toBeNull();
    });
  });

  it.skipIf(!existsSync(WORKER_SCRIPT))('prints one hook JSON line and exits without autostarting a worker', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-worker-json-'));
    const server = net.createServer();
    let port: number;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      port = address.port;
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    try {
      const result = spawnSync(process.execPath, [WORKER_SCRIPT, 'start'], {
        encoding: 'utf-8',
        timeout: 15_000,
        env: {
          ...process.env,
          CLAUDE_MEM_WORKER_AUTOSTART: 'false',
          CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
          CLAUDE_MEM_WORKER_PORT: String(port),
          CLAUDE_MEM_DATA_DIR: dataDir,
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.continue).toBe(true);
      expect(parsed.suppressOutput).toBe(true);
      expect(['ready', 'error']).toContain(parsed.status);
      expect(existsSync(path.join(dataDir, 'worker.pid'))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});
