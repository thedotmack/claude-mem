// Local API token mode (#5141): the policy both servers share.
import { describe, expect, it } from 'bun:test';
import {
  LOCAL_API_TOKEN_HEADER,
  decideLocalApiAccess,
  extractLocalApiToken,
  normalizeLocalApiToken,
  localApiTokenHeaders,
  localApiTokenHeadersFor,
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

// #6390: one remote worker, named by the user, may receive the token. Every other
// host still gets nothing, and the loopback rule is unchanged.
describe('localApiTokenHeadersFor', () => {
  const CLIENTS = { localOrigin: 'http://127.0.0.1:37777', configuredHost: '127.0.0.1' };
  const headers = (over: Partial<Parameters<typeof localApiTokenHeadersFor>[0]> = {}) =>
    localApiTokenHeadersFor({ token: TOKEN, workerOrigin: CLIENTS.localOrigin, remoteTokenHost: '', ...CLIENTS, ...over });

  it('sends the token to this machine\'s worker exactly as before when no remote host is named', () => {
    expect(headers()).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
  });

  it('adds nothing without a token, whatever the hosts say', () => {
    expect(headers({ token: '', remoteTokenHost: 'worker.example.com', configuredHost: 'worker.example.com', workerOrigin: 'https://worker.example.com' })).toEqual({});
    expect(headers({ token: '   ' })).toEqual({});
  });

  it('still never sends the token to any other loopback address', () => {
    // An SSH forward to another machine's worker looks exactly like this.
    expect(headers({ workerOrigin: 'http://127.0.0.1:9' })).toEqual({});
    expect(headers({ workerOrigin: 'http://localhost:37777' })).toEqual({});
  });

  it('sends the token to the named remote host when it equals CLAUDE_MEM_WORKER_HOST', () => {
    expect(headers({
      configuredHost: 'worker.example.com',
      remoteTokenHost: 'worker.example.com',
      workerOrigin: 'https://worker.example.com',
      localOrigin: 'http://worker.example.com:37777',
    })).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
  });

  it('sends nothing when the setting and the configured host differ, even by case or whitespace', () => {
    expect(headers({
      configuredHost: 'worker.example.com',
      remoteTokenHost: 'other.example.com',
      workerOrigin: 'https://other.example.com',
      localOrigin: 'http://worker.example.com:37777',
    })).toEqual({});
    expect(headers({
      configuredHost: 'worker.example.com',
      remoteTokenHost: ' Worker.example.com',
      workerOrigin: 'https://worker.example.com',
      localOrigin: 'http://worker.example.com:37777',
    })).toEqual({});
  });

  it('sends nothing to a host the setting names unless the request actually goes there', () => {
    expect(headers({
      configuredHost: 'worker.example.com',
      remoteTokenHost: 'worker.example.com',
      workerOrigin: 'https://attacker.example.com',
      localOrigin: 'http://worker.example.com:37777',
    })).toEqual({});
  });

  it('treats a loopback URL as another local port, never as the remote host', () => {
    // Naming 127.0.0.1 as the remote host must not reopen the SSH-forward hole.
    expect(headers({
      configuredHost: '127.0.0.1',
      remoteTokenHost: '127.0.0.1',
      workerOrigin: 'http://127.0.0.1:9',
    })).toEqual({});
  });

  it('sends nothing when the configured host is not a loopback address and no remote host is named', () => {
    expect(headers({
      configuredHost: 'worker.example.com',
      workerOrigin: 'https://worker.example.com',
      localOrigin: 'http://worker.example.com:37777',
    })).toEqual({});
  });

  it('covers a remote worker reached by host and port, with no explicit CLAUDE_MEM_WORKER_URL', () => {
    // The same origin, so the old URL comparison could not tell them apart either way.
    expect(headers({
      configuredHost: 'worker.example.com',
      remoteTokenHost: 'worker.example.com',
      workerOrigin: 'http://worker.example.com:37777',
      localOrigin: 'http://worker.example.com:37777',
    })).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
    expect(headers({
      configuredHost: 'worker.example.com',
      workerOrigin: 'http://worker.example.com:37777',
      localOrigin: 'http://worker.example.com:37777',
    })).toEqual({});
  });
});
