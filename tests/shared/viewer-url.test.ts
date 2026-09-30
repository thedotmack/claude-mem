import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { viewerBaseUrl } from '../../src/shared/viewer-url.js';
import { workerRestartUrl } from '../../src/shared/observer-health.js';

describe('viewerBaseUrl', () => {
  const originalPublicUrl = process.env.CLAUDE_MEM_PUBLIC_URL;

  beforeEach(() => {
    delete process.env.CLAUDE_MEM_PUBLIC_URL;
  });

  afterEach(() => {
    if (originalPublicUrl === undefined) delete process.env.CLAUDE_MEM_PUBLIC_URL;
    else process.env.CLAUDE_MEM_PUBLIC_URL = originalPublicUrl;
  });

  it('falls back to loopback when no public URL is configured', () => {
    expect(viewerBaseUrl(37742, '')).toBe('http://localhost:37742');
    expect(viewerBaseUrl('37742', undefined)).toBe('http://localhost:37742');
  });

  it('uses the configured public URL without a trailing slash', () => {
    expect(viewerBaseUrl(37700, ' https://37700.host.alice.example/ ')).toBe('https://37700.host.alice.example');
  });

  it('lets the env var win over the settings value', () => {
    process.env.CLAUDE_MEM_PUBLIC_URL = 'https://from-env.example';
    expect(viewerBaseUrl(37700, 'https://from-settings.example')).toBe('https://from-env.example');
  });

  it('puts the observer-health restart link on the same base as the viewer', () => {
    // Loopback first: hook settings are read once per process, so the cached
    // copy must be taken while no public URL is configured.
    expect(workerRestartUrl()).toMatch(/^http:\/\/localhost:\d+\/restart$/);

    process.env.CLAUDE_MEM_PUBLIC_URL = 'https://37700.host.alice.example/';
    expect(workerRestartUrl()).toBe('https://37700.host.alice.example/restart');
  });
});
