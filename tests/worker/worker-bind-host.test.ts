import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import http from 'http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import type { AddressInfo } from 'net';
import { networkInterfaces } from 'os';
import path from 'path';
import { readLegacyTvToken, resolveWorkerBindHost, warnOnPlainHttpRemoteTokenHost } from '../../src/services/worker/worker-bind-host.js';
import { logger } from '../../src/utils/logger.js';

// Observation TV was removed. An install that still has CLAUDE_MEM_TV_TOKEN with a
// non-loopback CLAUDE_MEM_WORKER_HOST used to expose only the read-only TV paths; it must
// not now silently expose the full worker API (provider API keys via GET /api/settings).

// Project-local scratch (gitignored), as in tests/services/auto-update/worker-auto-update-timer.test.ts.
const scratchRoot = path.join(import.meta.dir, '..', '..', '.scratch', 'test-runs');

let settingsDir: string;
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  mkdirSync(scratchRoot, { recursive: true });
  settingsDir = mkdtempSync(path.join(scratchRoot, 'worker-bind-host-'));
});

afterAll(() => {
  rmSync(settingsDir, { recursive: true, force: true });
});

afterEach(() => {
  errorSpy?.mockRestore();
  warnSpy?.mockRestore();
});

function spyOnLogs(): void {
  errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
  warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
}

function writeSettings(name: string, settings: Record<string, unknown>): string {
  const settingsPath = path.join(settingsDir, `${name}.json`);
  writeFileSync(settingsPath, JSON.stringify(settings));
  return settingsPath;
}

/** A non-loopback IPv4 address of this machine, or null when it has none (some CI sandboxes). */
function lanIpv4Address(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

async function listenOn(host: string): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => { res.end('worker'); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  return { server, port: (server.address() as AddressInfo).port };
}

async function reachable(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

describe('a leftover CLAUDE_MEM_TV_TOKEN with a non-loopback host and no local API token', () => {
  it('binds to loopback instead and logs an error saying Observation TV was removed', async () => {
    spyOnLogs();
    const settingsPath = writeSettings('tv-token-no-local-token', {
      CLAUDE_MEM_WORKER_HOST: '0.0.0.0',
      CLAUDE_MEM_TV_TOKEN: 'leftover-tv-token',
    });

    const host = resolveWorkerBindHost({
      configuredHost: '0.0.0.0',
      legacyTvToken: readLegacyTvToken(settingsPath, {}),
      localApiTokenSet: false,
    });

    expect(host).toBe('127.0.0.1');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [component, message, context] = errorSpy.mock.calls[0];
    expect(component).toBe('SECURITY');
    expect(message).toContain('Observation TV was removed');
    expect(message).toContain('CLAUDE_MEM_LOCAL_API_TOKEN');
    expect(message).not.toContain('leftover-tv-token');
    expect(context).toEqual({ configuredHost: '0.0.0.0', boundHost: '127.0.0.1' });

    // The bound socket answers on loopback and not on this machine's LAN address.
    const { server, port } = await listenOn(host);
    try {
      expect(await reachable('127.0.0.1', port)).toBe(true);
      const lanAddress = lanIpv4Address();
      if (lanAddress) expect(await reachable(lanAddress, port)).toBe(false);
    } finally {
      server.close();
    }
  });

  it('finds the token in the environment too', () => {
    spyOnLogs();
    const settingsPath = writeSettings('no-tv-token-in-file', { CLAUDE_MEM_WORKER_HOST: '0.0.0.0' });

    const host = resolveWorkerBindHost({
      configuredHost: '0.0.0.0',
      legacyTvToken: readLegacyTvToken(settingsPath, { CLAUDE_MEM_TV_TOKEN: 'leftover-env-token' }),
      localApiTokenSet: false,
    });

    expect(host).toBe('127.0.0.1');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('treats a saved boolean token as present, as the old settings reader did', () => {
    // coercePersistedSettingValue turned a saved boolean into "true"/"false", which turned
    // the TV guard on. Reading it as absent would expose the full API on a 0.0.0.0 bind.
    spyOnLogs();
    for (const saved of [true, false]) {
      const settingsPath = writeSettings(`boolean-tv-token-${saved}`, {
        CLAUDE_MEM_WORKER_HOST: '0.0.0.0',
        CLAUDE_MEM_TV_TOKEN: saved,
      });
      expect(readLegacyTvToken(settingsPath, {})).toBe(String(saved));
      expect(resolveWorkerBindHost({
        configuredHost: '0.0.0.0',
        legacyTvToken: readLegacyTvToken(settingsPath, {}),
        localApiTokenSet: false,
      })).toBe('127.0.0.1');
    }
  });

  it('finds the token in a nested { env } settings document', () => {
    const settingsPath = writeSettings('nested-tv-token', { env: { CLAUDE_MEM_TV_TOKEN: ' nested-token ' } });
    expect(readLegacyTvToken(settingsPath, {})).toBe('nested-token');
  });

  it('falls back to ::1 for an IPv6 bind-all host, which local clients reach as ::1', () => {
    spyOnLogs();
    const host = resolveWorkerBindHost({ configuredHost: '::', legacyTvToken: 'leftover', localApiTokenSet: false });
    expect(host).toBe('::1');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('a leftover CLAUDE_MEM_TV_TOKEN when the local API token is set', () => {
  it('honors the configured host and only warns that the TV token is ignored', async () => {
    spyOnLogs();
    const settingsPath = writeSettings('tv-token-with-local-token', {
      CLAUDE_MEM_WORKER_HOST: '0.0.0.0',
      CLAUDE_MEM_TV_TOKEN: 'leftover-tv-token',
      CLAUDE_MEM_LOCAL_API_TOKEN: 'local-api-token',
    });

    const host = resolveWorkerBindHost({
      configuredHost: '0.0.0.0',
      legacyTvToken: readLegacyTvToken(settingsPath, {}),
      localApiTokenSet: true,
    });

    expect(host).toBe('0.0.0.0');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [component, message] = warnSpy.mock.calls[0];
    expect(component).toBe('SECURITY');
    expect(message).toContain('CLAUDE_MEM_TV_TOKEN is set but ignored');

    // The configured bind-all host is kept: the socket answers on the LAN address as well.
    const { server, port } = await listenOn(host);
    try {
      expect(await reachable('127.0.0.1', port)).toBe(true);
      const lanAddress = lanIpv4Address();
      if (lanAddress) expect(await reachable(lanAddress, port)).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe('without a leftover CLAUDE_MEM_TV_TOKEN', () => {
  it('keeps a loopback host and logs nothing', () => {
    spyOnLogs();
    expect(resolveWorkerBindHost({ configuredHost: '127.0.0.1', legacyTvToken: '', localApiTokenSet: false })).toBe('127.0.0.1');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps a non-loopback host (the Docker setup) and warns that the full API is reachable', () => {
    spyOnLogs();
    expect(resolveWorkerBindHost({ configuredHost: '0.0.0.0', legacyTvToken: '', localApiTokenSet: false })).toBe('0.0.0.0');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toContain('no CLAUDE_MEM_LOCAL_API_TOKEN');
  });

  it('keeps a non-loopback host silently when the local API token guards it', () => {
    spyOnLogs();
    expect(resolveWorkerBindHost({ configuredHost: '0.0.0.0', legacyTvToken: '', localApiTokenSet: true })).toBe('0.0.0.0');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reads no token from a settings file that does not exist', () => {
    expect(readLegacyTvToken(path.join(settingsDir, 'missing.json'), {})).toBe('');
  });
});

// #6390: a remote host the user names receives the token in a header, so a plain-HTTP
// hop to it puts the token on the wire in the clear. Warn once at boot; never refuse,
// for the same reason the non-loopback bind above only warns.
describe('warnOnPlainHttpRemoteTokenHost', () => {
  const REMOTE = 'worker.example.com';

  it('warns when the token would go over plain HTTP to a non-loopback host', () => {
    spyOnLogs();
    warnOnPlainHttpRemoteTokenHost({
      configuredHost: REMOTE,
      localApiTokenSet: true,
      remoteTokenHost: REMOTE,
      workerUrl: `http://${REMOTE}:37777`,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [component, message] = warnSpy.mock.calls[0];
    expect(component).toBe('SECURITY');
    expect(message).toContain(REMOTE);
    expect(message).toContain('plain HTTP');
    // The message names the remedy, and never the token itself.
    expect(message).toContain('https');
    expect(message).not.toContain('local-api-token');
  });

  it('stays quiet for an https worker', () => {
    spyOnLogs();
    warnOnPlainHttpRemoteTokenHost({
      configuredHost: REMOTE,
      localApiTokenSet: true,
      remoteTokenHost: REMOTE,
      workerUrl: `https://${REMOTE}`,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stays quiet when no remote host is named, so the token never leaves the machine', () => {
    spyOnLogs();
    warnOnPlainHttpRemoteTokenHost({
      configuredHost: REMOTE,
      localApiTokenSet: true,
      remoteTokenHost: '',
      workerUrl: `http://${REMOTE}:37777`,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stays quiet when no token is set, or the two hosts differ, or either is loopback', () => {
    spyOnLogs();
    warnOnPlainHttpRemoteTokenHost({ configuredHost: REMOTE, localApiTokenSet: false, remoteTokenHost: REMOTE, workerUrl: `http://${REMOTE}:37777` });
    warnOnPlainHttpRemoteTokenHost({ configuredHost: REMOTE, localApiTokenSet: true, remoteTokenHost: 'other.example.com', workerUrl: `http://${REMOTE}:37777` });
    warnOnPlainHttpRemoteTokenHost({ configuredHost: '127.0.0.1', localApiTokenSet: true, remoteTokenHost: '127.0.0.1', workerUrl: 'http://127.0.0.1:37777' });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
