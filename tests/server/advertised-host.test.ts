// SPDX-License-Identifier: Apache-2.0
//
// /v1/connect returns a command the caller pastes into a shell, and the host
// in it can come from the request's Host header. These are the values the
// route may advertise; everything else is refused with InvalidHost.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { isValidAdvertisedHost } from '../../src/server/middleware/request-auth-helpers.js';
import { mcpConnectUrl } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';

describe('isValidAdvertisedHost', () => {
  it('accepts hostnames, IPv4, and bracketed IPv6 with an optional port', () => {
    expect(isValidAdvertisedHost('localhost')).toBe(true);
    expect(isValidAdvertisedHost('localhost:37877')).toBe(true);
    expect(isValidAdvertisedHost('127.0.0.1:37877')).toBe(true);
    expect(isValidAdvertisedHost('cmem.example.com')).toBe(true);
    expect(isValidAdvertisedHost('[::1]:37877')).toBe(true);
    expect(isValidAdvertisedHost(' CMEM.example ')).toBe(true);
  });

  it('refuses values that cannot be a host or would break the command', () => {
    expect(isValidAdvertisedHost('')).toBe(false);
    expect(isValidAdvertisedHost('evil.example:notaport')).toBe(false);
    expect(isValidAdvertisedHost('evil.example/path')).toBe(false);
    expect(isValidAdvertisedHost('evil.example with-space')).toBe(false);
    expect(isValidAdvertisedHost('evil.example"; rm -rf /')).toBe(false);
    expect(isValidAdvertisedHost('user@host')).toBe(false);
    expect(isValidAdvertisedHost('[::1')).toBe(false);
  });
});

describe('isValidAdvertisedHost edge cases', () => {
  it('accepts Docker names, fully qualified names and mapped IPv6', () => {
    expect(isValidAdvertisedHost('claude_mem:37777')).toBe(true);
    expect(isValidAdvertisedHost('project_service_1')).toBe(true);
    expect(isValidAdvertisedHost('api.example.com.')).toBe(true);
    expect(isValidAdvertisedHost('api.example.com.:37877')).toBe(true);
    expect(isValidAdvertisedHost('[::ffff:127.0.0.1]:1')).toBe(true);
    expect(isValidAdvertisedHost('localhost:65535')).toBe(true);
  });

  it('refuses malformed IPv6 literals and ports outside 1-65535', () => {
    expect(isValidAdvertisedHost('[:::]')).toBe(false);
    expect(isValidAdvertisedHost('[1234]')).toBe(false);
    expect(isValidAdvertisedHost('[fe80::1%eth0]')).toBe(false);
    expect(isValidAdvertisedHost('[::1]x')).toBe(false);
    expect(isValidAdvertisedHost('localhost:99999')).toBe(false);
    expect(isValidAdvertisedHost('localhost:65536')).toBe(false);
    expect(isValidAdvertisedHost('localhost:0')).toBe(false);
    expect(isValidAdvertisedHost('localhost:')).toBe(false);
    expect(isValidAdvertisedHost('api..example.com')).toBe(false);
    expect(isValidAdvertisedHost('.')).toBe(false);
  });
});

describe('mcpConnectUrl', () => {
  let savedPublicUrl: string | undefined;
  beforeEach(() => {
    savedPublicUrl = process.env.CLAUDE_MEM_PUBLIC_URL;
    delete process.env.CLAUDE_MEM_PUBLIC_URL;
  });
  afterEach(() => {
    if (savedPublicUrl === undefined) delete process.env.CLAUDE_MEM_PUBLIC_URL;
    else process.env.CLAUDE_MEM_PUBLIC_URL = savedPublicUrl;
  });
  const request = (host: string | undefined) => ({ protocol: 'http', get: (_name: string) => host }) as never;

  it('falls back to localhost when the request has no Host header', () => {
    expect(mcpConnectUrl(request(undefined))).toBe('http://localhost/v1/mcp');
  });

  it('refuses a Host header that is present but unusable', () => {
    expect(mcpConnectUrl(request(''))).toBeNull();
    expect(mcpConnectUrl(request('evil.example with-space'))).toBeNull();
  });

  it('uses CLAUDE_MEM_PUBLIC_URL over the Host header when it is set', () => {
    process.env.CLAUDE_MEM_PUBLIC_URL = 'https://memory.example.com/';
    expect(mcpConnectUrl(request('evil.example with-space'))).toBe('https://memory.example.com/v1/mcp');
  });
});
