// SPDX-License-Identifier: Apache-2.0
//
// /v1/connect returns a command the caller pastes into a shell, and the host
// in it can come from the request's Host header. These are the values the
// route may advertise; everything else is refused with InvalidHost.

import { describe, expect, it } from 'bun:test';
import { isValidAdvertisedHost } from '../../src/server/middleware/request-auth-helpers.js';

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