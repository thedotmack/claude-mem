// Local API token mode (#5141): the policy both servers share.
import { describe, expect, it } from 'bun:test';
import {
  LOCAL_API_TOKEN_COOKIE,
  LOCAL_API_TOKEN_HEADER,
  decideLocalApiAccess,
  extractLocalApiToken,
  normalizeLocalApiToken,
  readCookieToken,
  localApiTokenHeaders,
  safeEqualSecret,
} from '../../src/shared/local-api-token.js';

const TOKEN = 'owner-test-secret-token';

function decide(method: string, path: string, presentedToken: string | null, expectedToken = TOKEN) {
  return decideLocalApiAccess({ method, path, presentedToken, expectedToken });
}

describe('decideLocalApiAccess', () => {
  it('refuses a request with no token, and one with the wrong token', () => {
    expect(decide('GET', '/api/settings', null)).toEqual({ allow: false, reason: 'token' });
    expect(decide('GET', '/api/settings', 'wrong')).toEqual({ allow: false, reason: 'token' });
    expect(decide('POST', '/api/admin/shutdown', '')).toEqual({ allow: false, reason: 'token' });
  });

  it('admits the right token on any route and method', () => {
    for (const [method, path] of [['GET', '/api/settings'], ['POST', '/api/admin/shutdown'], ['DELETE', '/api/observation/1']]) {
      expect(decide(method, path, TOKEN)).toEqual({ allow: true });
    }
  });

  it('fails closed when the expected token is empty, even for an open route', () => {
    expect(decide('GET', '/api/settings', 'anything', '')).toEqual({ allow: false, reason: 'token' });
    expect(decide('GET', '/api/health', null, '')).toEqual({ allow: false, reason: 'token' });
  });

  it('leaves exactly one route open without a token: the health probe', () => {
    expect(decide('GET', '/api/health', null)).toEqual({ allow: true });
    for (const [method, path] of [['GET', '/api/readiness'], ['GET', '/api/ready'], ['POST', '/api/spool/ingest']]) {
      expect(decide(method, path, null)).toEqual({ allow: false, reason: 'token' });
    }
  });

  it('matches open routes exactly: method, case, trailing slash, prefix and extra segments all need the token', () => {
    for (const [method, path] of [
      ['POST', '/api/health'],
      ['HEAD', '/api/health'],
      ['GET', '/api/health/'],
      ['GET', '/API/health'],
      ['GET', '//api/health'],
      ['GET', '/api/health/details'],
      ['GET', '/api/readiness/x'],
      ['GET', '/api/spool/ingest'],
      ['PUT', '/api/spool/ingest'],
      ['GET', '/api/admin/doctor'],
    ]) {
      expect(decide(method, path, null)).toEqual({ allow: false, reason: 'token' });
    }
  });
});

describe('extractLocalApiToken', () => {
  it('reads X-Claude-Mem-Token', () => {
    expect(extractLocalApiToken({ [LOCAL_API_TOKEN_HEADER]: ` ${TOKEN} ` })).toBe(TOKEN);
  });

  it('reads Authorization: Bearer, in any case', () => {
    expect(extractLocalApiToken({ authorization: `Bearer ${TOKEN}` })).toBe(TOKEN);
    expect(extractLocalApiToken({ authorization: `bearer ${TOKEN}` })).toBe(TOKEN);
  });

  it('prefers the dedicated header over Authorization', () => {
    expect(extractLocalApiToken({ [LOCAL_API_TOKEN_HEADER]: TOKEN, authorization: 'Bearer other' })).toBe(TOKEN);
  });

  it('returns null for nothing, a blank value, a non-Bearer scheme, or a repeated header', () => {
    expect(extractLocalApiToken({})).toBeNull();
    expect(extractLocalApiToken({ [LOCAL_API_TOKEN_HEADER]: '   ' })).toBeNull();
    expect(extractLocalApiToken({ authorization: `Basic ${TOKEN}` })).toBeNull();
    expect(extractLocalApiToken({ authorization: ['Bearer a', 'Bearer b'] })).toBeNull();
  });
});

describe('readCookieToken', () => {
  const name = LOCAL_API_TOKEN_COOKIE;

  it('reads the token among other cookies', () => {
    expect(readCookieToken(`a=1; ${name}=${TOKEN}; b=2`)).toBe(TOKEN);
    expect(readCookieToken(`${name}=${TOKEN}`)).toBe(TOKEN);
  });

  it('decodes a percent-encoded value, and reads one that cannot be decoded as no token', () => {
    expect(readCookieToken(`${name}=${encodeURIComponent('a b+c=')}`)).toBe('a b+c=');
    expect(readCookieToken(`${name}=%E0%A4%A`)).toBeNull();
  });

  it('returns null for no header, no such cookie, a blank value, a similar name, or a repeated name', () => {
    expect(readCookieToken(undefined)).toBeNull();
    expect(readCookieToken('a=1')).toBeNull();
    expect(readCookieToken(`${name}=`)).toBeNull();
    expect(readCookieToken(`x${name}=${TOKEN}`)).toBeNull();
    expect(readCookieToken(`${name}=${TOKEN}; ${name}=${TOKEN}`)).toBeNull();
  });
});

describe('normalizeLocalApiToken', () => {
  it('trims, and reads whitespace-only or a non-string as off', () => {
    expect(normalizeLocalApiToken(`  ${TOKEN}\n`)).toBe(TOKEN);
    expect(normalizeLocalApiToken('   ')).toBe('');
    expect(normalizeLocalApiToken(undefined)).toBe('');
    expect(normalizeLocalApiToken(42)).toBe('');
  });
});

describe('localApiTokenHeaders', () => {
  it('names the header when there is a token and adds nothing when there is not', () => {
    expect(localApiTokenHeaders(TOKEN)).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
    expect(localApiTokenHeaders('')).toEqual({});
  });
});

describe('safeEqualSecret', () => {
  it('compares by value, whatever the lengths', () => {
    expect(safeEqualSecret(TOKEN, TOKEN)).toBe(true);
    expect(safeEqualSecret(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(safeEqualSecret('', TOKEN)).toBe(false);
  });
});
