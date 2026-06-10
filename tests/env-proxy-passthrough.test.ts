import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  envFilePath,
  loadClaudeMemEnv,
  buildIsolatedEnv,
  applyProxyAndCaFromEnvFile,
  PROXY_AND_CA_PASSTHROUGH_KEYS,
} from '../src/shared/EnvManager.js';

/**
 * Tests for corporate-proxy / custom-CA passthrough via ~/.claude-mem/.env.
 *
 * Context: env-sanitizer deliberately strips HTTPS_PROXY / HTTP_PROXY / NO_PROXY
 * from the parent shell env so the persistent daemon never silently latches
 * onto a session-only proxy. For users behind Zscaler-style TLS-intercepting
 * corporate proxies that path makes api.anthropic.com unreachable: the daemon
 * tries a direct connection, the firewall presents a self-signed cert, Node
 * fetch rejects it, every observation-generation call fails.
 *
 * The fix is an opt-in: when HTTPS_PROXY / NODE_EXTRA_CA_CERTS / etc. are
 * declared in ~/.claude-mem/.env, they are:
 *   (a) read by loadClaudeMemEnv()
 *   (b) injected into the daemon's own process.env via applyProxyAndCaFromEnvFile()
 *   (c) propagated into buildIsolatedEnv() output so spawned subprocesses inherit
 *
 * Tests use CLAUDE_MEM_ENV_FILE override so the real ~/.claude-mem/.env is
 * never touched.
 */

const TEST_DATA_DIR = fs.mkdtempSync(join(tmpdir(), 'claude-mem-proxy-test-'));
const TEST_ENV_FILE = join(TEST_DATA_DIR, '.env');
const ORIGINAL_ENV_FILE = process.env.CLAUDE_MEM_ENV_FILE;

// Snapshot env vars we may mutate so the test never leaks state.
const SNAPSHOT_KEYS = [
  ...PROXY_AND_CA_PASSTHROUGH_KEYS,
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;
const original: Record<string, string | undefined> = {};

function snapshotEnv() {
  for (const k of SNAPSHOT_KEYS) original[k] = process.env[k];
}
function restoreEnv() {
  for (const k of SNAPSHOT_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
}

beforeAll(() => {
  process.env.CLAUDE_MEM_ENV_FILE = TEST_ENV_FILE;
});

afterAll(() => {
  if (ORIGINAL_ENV_FILE === undefined) delete process.env.CLAUDE_MEM_ENV_FILE;
  else process.env.CLAUDE_MEM_ENV_FILE = ORIGINAL_ENV_FILE;
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

beforeEach(() => {
  snapshotEnv();
  // start each test from a clean .env
  try { fs.unlinkSync(TEST_ENV_FILE); } catch { /* ignore */ }
  // and a clean process.env for the keys we care about
  for (const k of SNAPSHOT_KEYS) delete process.env[k];
});

describe('proxy + CA passthrough via ~/.claude-mem/.env', () => {
  it('loadClaudeMemEnv reads HTTPS_PROXY and NODE_EXTRA_CA_CERTS', () => {
    fs.writeFileSync(TEST_ENV_FILE,
      'HTTPS_PROXY=http://corp-proxy.example.com:3128/\n' +
      'NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt\n'
    );

    const env = loadClaudeMemEnv();
    expect(env.HTTPS_PROXY).toBe('http://corp-proxy.example.com:3128/');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/certs/ca-certificates.crt');

    restoreEnv();
  });

  it('applyProxyAndCaFromEnvFile injects values into process.env when absent', () => {
    fs.writeFileSync(TEST_ENV_FILE,
      'HTTPS_PROXY=http://corp-proxy.example.com:3128/\n' +
      'NO_PROXY=localhost,127.0.0.1\n' +
      'SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt\n'
    );

    const applied = applyProxyAndCaFromEnvFile();
    expect(applied).toContain('HTTPS_PROXY');
    expect(applied).toContain('NO_PROXY');
    expect(applied).toContain('SSL_CERT_FILE');

    expect(process.env.HTTPS_PROXY).toBe('http://corp-proxy.example.com:3128/');
    expect(process.env.NO_PROXY).toBe('localhost,127.0.0.1');
    expect(process.env.SSL_CERT_FILE).toBe('/etc/ssl/certs/ca-certificates.crt');

    // Lowercase mirroring for proxy vars (curl-family tooling)
    expect(process.env.https_proxy).toBe('http://corp-proxy.example.com:3128/');
    expect(process.env.no_proxy).toBe('localhost,127.0.0.1');

    restoreEnv();
  });

  it('applyProxyAndCaFromEnvFile does NOT overwrite values already set in process.env', () => {
    fs.writeFileSync(TEST_ENV_FILE, 'HTTPS_PROXY=http://from-envfile.example.com:3128/\n');

    process.env.HTTPS_PROXY = 'http://from-shell.example.com:8080/';
    const applied = applyProxyAndCaFromEnvFile();

    expect(applied).not.toContain('HTTPS_PROXY');
    expect(process.env.HTTPS_PROXY).toBe('http://from-shell.example.com:8080/');

    restoreEnv();
  });

  it('buildIsolatedEnv propagates proxy + CA vars to subprocess env', () => {
    fs.writeFileSync(TEST_ENV_FILE,
      'HTTPS_PROXY=http://corp-proxy.example.com:3128/\n' +
      'NODE_EXTRA_CA_CERTS=/opt/corp-ca.pem\n'
    );

    const isolated = buildIsolatedEnv(true);
    expect(isolated.HTTPS_PROXY).toBe('http://corp-proxy.example.com:3128/');
    expect(isolated.NODE_EXTRA_CA_CERTS).toBe('/opt/corp-ca.pem');

    restoreEnv();
  });

  it('buildIsolatedEnv with credentials=false does NOT inject proxy/CA (matches existing semantics)', () => {
    fs.writeFileSync(TEST_ENV_FILE, 'HTTPS_PROXY=http://corp-proxy.example.com:3128/\n');

    const isolated = buildIsolatedEnv(false);
    expect(isolated.HTTPS_PROXY).toBeUndefined();

    restoreEnv();
  });

  it('returns empty list when no proxy/CA keys declared', () => {
    fs.writeFileSync(TEST_ENV_FILE,
      'ANTHROPIC_API_KEY=sk-ant-test-not-real\n'
    );

    const applied = applyProxyAndCaFromEnvFile();
    expect(applied).toEqual([]);
    expect(process.env.HTTPS_PROXY).toBeUndefined();

    restoreEnv();
  });

  it('handles missing ~/.claude-mem/.env gracefully', () => {
    // no file written this test
    expect(() => applyProxyAndCaFromEnvFile()).not.toThrow();
    const applied = applyProxyAndCaFromEnvFile();
    expect(applied).toEqual([]);
    restoreEnv();
  });
});
