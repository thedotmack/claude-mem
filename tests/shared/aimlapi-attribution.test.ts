// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  AIMLAPI_APP_TITLE,
  AIMLAPI_APP_URL,
  AIMLAPI_PARTNER_ID,
  AIMLAPI_SOURCE,
  aimlapiAttributionHeaders,
} from '../../src/shared/aimlapi-attribution.js';

describe('aimlapi.com attribution identity', () => {
  // The partner id must match an active row in aimlapi.com's partner registry.
  // A typo does not error — the request simply serves untagged and the
  // integration's traffic stops being attributed, silently.
  it('pins the provisioned partner id', () => {
    expect(AIMLAPI_PARTNER_ID).toBe('part_Ilh1LOkwr8LXpT9Cgd8dTVyA');
    expect(AIMLAPI_PARTNER_ID).toMatch(/^part_[A-Za-z0-9]{1,64}$/);
  });

  // `<channel>/<client>`: the channel is a small closed set (agent|mcp|web)
  // and the client is this integration's registry slug.
  it('uses the agent/<slug> source form', () => {
    expect(AIMLAPI_SOURCE).toBe('agent/claude-mem');
    expect(AIMLAPI_SOURCE).toMatch(/^agent\/[a-z0-9-]{1,32}$/);
  });
});

describe('aimlapiAttributionHeaders', () => {
  it('always carries both attribution headers', () => {
    const h = aimlapiAttributionHeaders(undefined, undefined);
    expect(h['X-AIMLAPI-Source']).toBe(AIMLAPI_SOURCE);
    expect(h['X-AIMLAPI-Partner-ID']).toBe(AIMLAPI_PARTNER_ID);
  });

  it('falls back to the claude-mem app identity when unconfigured', () => {
    const h = aimlapiAttributionHeaders(undefined, undefined);
    expect(h['HTTP-Referer']).toBe(AIMLAPI_APP_URL);
    expect(h['X-Title']).toBe(AIMLAPI_APP_TITLE);
  });

  it('treats empty strings as unset', () => {
    const h = aimlapiAttributionHeaders('', '');
    expect(h['HTTP-Referer']).toBe(AIMLAPI_APP_URL);
    expect(h['X-Title']).toBe(AIMLAPI_APP_TITLE);
  });

  it('lets a user relabel their own traffic', () => {
    const h = aimlapiAttributionHeaders('https://example.test', 'My Build');
    expect(h['HTTP-Referer']).toBe('https://example.test');
    expect(h['X-Title']).toBe('My Build');
  });

  // The referer/title are cosmetic, but the source/partner pair identifies the
  // integration itself — user settings must not be able to reach them, or one
  // installation could misattribute (or un-attribute) everyone's traffic.
  it('does not let user settings touch the source/partner pair', () => {
    const h = aimlapiAttributionHeaders('https://example.test', 'My Build');
    expect(h['X-AIMLAPI-Source']).toBe(AIMLAPI_SOURCE);
    expect(h['X-AIMLAPI-Partner-ID']).toBe(AIMLAPI_PARTNER_ID);
  });
});
