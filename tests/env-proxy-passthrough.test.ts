import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PROXY_AND_CA_PASSTHROUGH_KEYS,
  applyProxyAndCaFromEnvFile,
  buildIsolatedEnv,
  loadClaudeMemEnv,
} from '../src/shared/EnvManager.js';
import { sanitizeEnv } from '../src/supervisor/env-sanitizer.js';

const TEST_DATA_DIR = fs.mkdtempSync(join(tmpdir(), 'claude-mem-proxy-test-'));
const TEST_ENV_FILE = join(TEST_DATA_DIR, '.env');
const ORIGINAL_ENV_FILE = process.env.CLAUDE_MEM_ENV_FILE;

const SNAPSHOT_KEYS = [
  ...PROXY_AND_CA_PASSTHROUGH_KEYS,
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;
const ORIGINAL_ENV = Object.fromEntries(
  SNAPSHOT_KEYS.map((key) => [key, process.env[key]]),
) as Record<typeof SNAPSHOT_KEYS[number], string | undefined>;

function restoreEnv(): void {
  for (const key of SNAPSHOT_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

describe('proxy and CA passthrough from claude-mem env file', () => {
  beforeAll(() => {
    process.env.CLAUDE_MEM_ENV_FILE = TEST_ENV_FILE;
  });

  beforeEach(() => {
    try { fs.unlinkSync(TEST_ENV_FILE); } catch { /* ignore */ }
    for (const key of SNAPSHOT_KEYS) delete process.env[key];
  });

  afterAll(() => {
    restoreEnv();
    if (ORIGINAL_ENV_FILE === undefined) delete process.env.CLAUDE_MEM_ENV_FILE;
    else process.env.CLAUDE_MEM_ENV_FILE = ORIGINAL_ENV_FILE;
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('loads only allowlisted proxy and CA keys from the env file', () => {
    fs.writeFileSync(
      TEST_ENV_FILE,
      [
        'HTTPS_PROXY=http://corp-proxy.example.com:3128',
        'NODE_EXTRA_CA_CERTS=/opt/corp-ca.pem',
        'AWS_SECRET_ACCESS_KEY=must-not-load',
        'CLAUDE_CODE_USE_BEDROCK=must-not-load',
        '',
      ].join('\n'),
    );

    const env = loadClaudeMemEnv() as Record<string, string | undefined>;

    expect(env.HTTPS_PROXY).toBe('http://corp-proxy.example.com:3128');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/opt/corp-ca.pem');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  it('replaces ambient proxy and CA values with explicit env-file values', () => {
    fs.writeFileSync(
      TEST_ENV_FILE,
      [
        'HTTPS_PROXY=http://from-env-file.example.com:3128',
        'HTTP_PROXY=http://from-env-file.example.com:8080',
        'NO_PROXY=localhost,127.0.0.1',
        'SSL_CERT_FILE=/opt/corp-ssl.pem',
        '',
      ].join('\n'),
    );
    process.env.HTTP_PROXY = 'http://from-shell.example.com:8080';
    process.env.ALL_PROXY = 'socks5://ambient.example.com:1080';
    process.env.NODE_EXTRA_CA_CERTS = '/tmp/ambient-ca.pem';

    const applied = applyProxyAndCaFromEnvFile();

    expect(applied).toContain('HTTPS_PROXY');
    expect(applied).toContain('HTTP_PROXY');
    expect(applied).toContain('NO_PROXY');
    expect(applied).toContain('SSL_CERT_FILE');
    expect(process.env.HTTPS_PROXY).toBe('http://from-env-file.example.com:3128');
    expect(process.env.https_proxy).toBe('http://from-env-file.example.com:3128');
    expect(process.env.HTTP_PROXY).toBe('http://from-env-file.example.com:8080');
    expect(process.env.http_proxy).toBe('http://from-env-file.example.com:8080');
    expect(process.env.ALL_PROXY).toBeUndefined();
    expect(process.env.NO_PROXY).toBe('localhost,127.0.0.1');
    expect(process.env.no_proxy).toBe('localhost,127.0.0.1');
    expect(process.env.SSL_CERT_FILE).toBe('/opt/corp-ssl.pem');
    expect(process.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it('buildIsolatedEnv strips ambient proxy/CA values and reinjects explicit env-file values', () => {
    process.env.HTTPS_PROXY = 'http://ambient.example.com:3128';
    process.env.NODE_EXTRA_CA_CERTS = '/tmp/ambient-ca.pem';
    fs.writeFileSync(
      TEST_ENV_FILE,
      'HTTPS_PROXY=http://configured.example.com:3128\nNODE_EXTRA_CA_CERTS=/opt/corp-ca.pem\n',
    );

    const isolated = buildIsolatedEnv(true);
    const sanitized = sanitizeEnv(isolated);

    expect(isolated.HTTPS_PROXY).toBe('http://configured.example.com:3128');
    expect(isolated.NODE_EXTRA_CA_CERTS).toBe('/opt/corp-ca.pem');
    expect(sanitized.HTTPS_PROXY).toBe('http://configured.example.com:3128');
    expect(sanitized.NODE_EXTRA_CA_CERTS).toBe('/opt/corp-ca.pem');
  });

  it('buildIsolatedEnv(false) does not inject env-file proxy/CA values', () => {
    fs.writeFileSync(TEST_ENV_FILE, 'HTTPS_PROXY=http://configured.example.com:3128\n');

    const isolated = buildIsolatedEnv(false);

    expect(isolated.HTTPS_PROXY).toBeUndefined();
  });
});
