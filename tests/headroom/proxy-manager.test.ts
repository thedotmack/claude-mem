import { describe, it, expect, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { spawn, ChildProcess } from 'node:child_process';

import { HeadroomProxyManager } from '../../src/services/headroom/HeadroomProxyManager.js';

/**
 * Unit-level supervision tests using the manager's injected test seams
 * (ChromaMcpManager.setUvxAvailabilityProbeForTesting pattern): no real
 * Python process is ever spawned and no real network call is made.
 *
 * Settings injection: the manager reads settings via
 * SettingsDefaultsManager.loadFromFile, which applies applyEnvOverrides —
 * process.env.CLAUDE_MEM_HEADROOM_* wins over settings.json (same route as
 * tests/headroom/headroom-service.test.ts; data dir pinned by tests/preload.ts).
 */

const savedHeadroomEnabled = process.env.CLAUDE_MEM_HEADROOM_ENABLED;
const savedHeadroomUrl = process.env.CLAUDE_MEM_HEADROOM_URL;

function restoreEnv(key: string, savedValue: string | undefined): void {
  if (savedValue === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = savedValue;
  }
}

/**
 * Minimal ChildProcess stand-in. The pid is deliberately impossible on macOS
 * and Linux (both cap pids well below 9,999,999) so the identity-guarded
 * tree-kill in stop() can never touch a real process.
 */
class FakeChild extends EventEmitter {
  pid = 9_999_999;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = null;
  stderr = null;
  kill(): boolean {
    return true;
  }
}

interface SpawnRecord {
  command: string;
  args: string[];
}

function installSpawnRecorder(): SpawnRecord[] {
  const calls: SpawnRecord[] = [];
  const fakeSpawn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    return new FakeChild() as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  HeadroomProxyManager.setSpawnForTesting(fakeSpawn);
  return calls;
}

describe('HeadroomProxyManager', () => {
  afterEach(async () => {
    HeadroomProxyManager.setSpawnForTesting(null);
    HeadroomProxyManager.setHealthProbeForTesting(null);
    HeadroomProxyManager.setCommandResolverForTesting(null);
    HeadroomProxyManager.setKillProcessTreeForTesting(null);
    await HeadroomProxyManager.reset();
    restoreEnv('CLAUDE_MEM_HEADROOM_ENABLED', savedHeadroomEnabled);
    restoreEnv('CLAUDE_MEM_HEADROOM_URL', savedHeadroomUrl);
  });

  describe('start with CLAUDE_MEM_HEADROOM_ENABLED=false', () => {
    it('should be a no-op: no health probe, no spawn attempted', async () => {
      process.env.CLAUDE_MEM_HEADROOM_ENABLED = 'false';

      const spawnCalls = installSpawnRecorder();
      let healthProbeCalls = 0;
      HeadroomProxyManager.setHealthProbeForTesting(() => {
        healthProbeCalls++;
        return Promise.resolve({ status: 'ok' });
      });

      await HeadroomProxyManager.getInstance().start();

      expect(spawnCalls).toHaveLength(0);
      expect(healthProbeCalls).toBe(0);
    });
  });

  describe('start with an already-healthy (user-run) proxy', () => {
    it('should probe health and not spawn a managed proxy', async () => {
      process.env.CLAUDE_MEM_HEADROOM_ENABLED = 'true';

      const spawnCalls = installSpawnRecorder();
      let healthProbeCalls = 0;
      HeadroomProxyManager.setHealthProbeForTesting(() => {
        healthProbeCalls++;
        return Promise.resolve({ status: 'ok' });
      });
      // Tripwire: the binary must not even be looked up when a user-run
      // proxy already answers.
      HeadroomProxyManager.setCommandResolverForTesting(() => {
        throw new Error('binary resolution must not run when the proxy is already healthy');
      });

      await HeadroomProxyManager.getInstance().start();

      expect(healthProbeCalls).toBe(1);
      expect(spawnCalls).toHaveLength(0);
    });
  });

  describe('start with no proxy answering and the binary present', () => {
    it('should spawn `headroom proxy --port <port from CLAUDE_MEM_HEADROOM_URL>`', async () => {
      process.env.CLAUDE_MEM_HEADROOM_ENABLED = 'true';
      process.env.CLAUDE_MEM_HEADROOM_URL = 'http://127.0.0.1:9123';

      const spawnCalls = installSpawnRecorder();
      // healthCheck() REJECTS while nothing listens (raw promise, no
      // fallback); after the spawn the poll sees a healthy proxy.
      let healthProbeCalls = 0;
      HeadroomProxyManager.setHealthProbeForTesting(() => {
        healthProbeCalls++;
        return healthProbeCalls === 1
          ? Promise.reject(new Error('connection refused'))
          : Promise.resolve({ status: 'ok' });
      });
      HeadroomProxyManager.setCommandResolverForTesting(() => '/fake/bin/headroom');

      await HeadroomProxyManager.getInstance().start();

      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].command).toBe('/fake/bin/headroom');
      expect(spawnCalls[0].args).toEqual(['proxy', '--port', '9123']);
    });
  });

  describe('start with no proxy answering and the binary missing', () => {
    it('should run `uv tool install` with exact args, re-resolve the binary, then spawn the proxy', async () => {
      process.env.CLAUDE_MEM_HEADROOM_ENABLED = 'true';
      process.env.CLAUDE_MEM_HEADROOM_URL = 'http://127.0.0.1:8787';

      // Recorder whose uv-install child exits 0 so installHeadroomTool's
      // close-listener resolves instead of waiting out the 5-minute timeout.
      const spawnCalls: SpawnRecord[] = [];
      const fakeSpawn = ((command: string, args: string[]) => {
        spawnCalls.push({ command, args });
        const child = new FakeChild();
        if (args[0] === 'tool') {
          setImmediate(() => child.emit('close', 0));
        }
        return child as unknown as ChildProcess;
      }) as unknown as typeof spawn;
      HeadroomProxyManager.setSpawnForTesting(fakeSpawn);

      let healthProbeCalls = 0;
      HeadroomProxyManager.setHealthProbeForTesting(() => {
        healthProbeCalls++;
        return healthProbeCalls === 1
          ? Promise.reject(new Error('connection refused'))
          : Promise.resolve({ status: 'ok' });
      });

      // Binary absent before the install, present after — the re-resolve is
      // the branch under test.
      let resolverCalls = 0;
      HeadroomProxyManager.setCommandResolverForTesting(() => {
        resolverCalls++;
        return resolverCalls === 1 ? null : '/fake/bin/headroom';
      });

      await HeadroomProxyManager.getInstance().start();

      expect(resolverCalls).toBe(2);
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls[0].args).toEqual(['tool', 'install', '--python', '3.13', 'headroom-ai[proxy]']);
      expect(spawnCalls[1].command).toBe('/fake/bin/headroom');
      expect(spawnCalls[1].args).toEqual(['proxy', '--port', '8787']);
    });
  });

  describe('stop with no spawned child', () => {
    it('should never call killProcessTree (a user-run proxy is untouchable)', async () => {
      process.env.CLAUDE_MEM_HEADROOM_ENABLED = 'true';

      let killCalls = 0;
      HeadroomProxyManager.setKillProcessTreeForTesting((async () => {
        killCalls++;
      }) as never);

      // Nothing was ever spawned on this instance — stop() must be a no-op.
      await HeadroomProxyManager.getInstance().stop();

      expect(killCalls).toBe(0);
    });
  });

  describe('resolveProxyPort', () => {
    it('should parse the port from CLAUDE_MEM_HEADROOM_URL and default to 8787', () => {
      expect(HeadroomProxyManager.resolveProxyPort('http://127.0.0.1:9123')).toBe(9123);
      expect(HeadroomProxyManager.resolveProxyPort('http://127.0.0.1:8787')).toBe(8787);
      // No explicit port / unparseable value → the proxy's own default.
      expect(HeadroomProxyManager.resolveProxyPort('http://127.0.0.1')).toBe(8787);
      expect(HeadroomProxyManager.resolveProxyPort('')).toBe(8787);
    });
  });

  describe('getInstance', () => {
    it('should return the same lazy singleton instance', () => {
      expect(HeadroomProxyManager.getInstance()).toBe(HeadroomProxyManager.getInstance());
    });
  });
});
