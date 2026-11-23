// Local API token mode (#5141): the policy both servers share.
import { describe, expect, it, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
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

  // The #6390 spec: plain http to the named host works and warns; it is not refused.
  it('sends the token to the named remote host over plain HTTP, with a SECURITY warning', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      expect(headers({
        configuredHost: 'lan-worker.example.com',
        remoteTokenHost: 'lan-worker.example.com',
        workerOrigin: 'http://lan-worker.example.com:37777',
        localOrigin: 'http://lan-worker.example.com:37777',
      })).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
      const security = warn.mock.calls.filter(([component]) => component === 'SECURITY');
      expect(security).toHaveLength(1);
      expect(String(security[0][1])).toContain('http://lan-worker.example.com:37777');
      expect(String(security[0][1])).toContain('plain HTTP');
      // The warning names the destination, never the credential.
      expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);

      // Once per origin, so a long-lived MCP server does not log it on every request.
      headers({
        configuredHost: 'lan-worker.example.com',
        remoteTokenHost: 'lan-worker.example.com',
        workerOrigin: 'http://lan-worker.example.com:37777',
        localOrigin: 'http://lan-worker.example.com:37777',
      });
      expect(warn.mock.calls.filter(([component]) => component === 'SECURITY')).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('over plain HTTP, sends nothing to another port of the named host', () => {
    // Only the configured host and port is the http worker the user set up.
    expect(headers({
      configuredHost: 'worker.example.com',
      remoteTokenHost: 'worker.example.com',
      workerOrigin: 'http://worker.example.com:8080',
      localOrigin: 'http://worker.example.com:37777',
    })).toEqual({});
    // An explicit destination (HealthMonitor's) has no local origin to match.
    expect(headers({
      configuredHost: 'worker.example.com',
      remoteTokenHost: 'worker.example.com',
      workerOrigin: 'http://worker.example.com:37777',
      localOrigin: '',
    })).toEqual({});
  });

  it('over plain HTTP, sends nothing to an unnamed host, a near-match, or without the opt-in', () => {
    const base = { workerOrigin: 'http://worker.example.com:37777', localOrigin: 'http://worker.example.com:37777' };
    expect(headers({ ...base, configuredHost: 'worker.example.com', remoteTokenHost: '' })).toEqual({});
    expect(headers({ ...base, configuredHost: 'worker.example.com', remoteTokenHost: 'other.example.com' })).toEqual({});
    expect(headers({ ...base, configuredHost: 'worker.example.com', remoteTokenHost: 'Worker.example.com' })).toEqual({});
    expect(headers({ ...base, configuredHost: 'worker.example.com', remoteTokenHost: 'worker.example.co' })).toEqual({});
    expect(headers({
      configuredHost: 'worker.example.com',
      remoteTokenHost: 'worker.example.com',
      workerOrigin: 'http://attacker.example.com:37777',
      localOrigin: 'http://worker.example.com:37777',
    })).toEqual({});
  });

  it('sends nothing over any scheme other than http and https', () => {
    for (const workerOrigin of ['ws://worker.example.com:37777', 'ftp://worker.example.com', 'file:///worker.example.com']) {
      expect(headers({
        configuredHost: 'worker.example.com',
        remoteTokenHost: 'worker.example.com',
        workerOrigin,
        localOrigin: workerOrigin,
      })).toEqual({});
    }
  });

  it('sends nothing when the configured host is not a loopback address and no remote host is named', () => {
    expect(headers({
      configuredHost: 'worker.example.com',
      workerOrigin: 'https://worker.example.com',
      localOrigin: 'http://worker.example.com:37777',
    })).toEqual({});
  });

  it('matches an IPv6 literal whether the setting brackets it or not', () => {
    // URL.hostname reports an IPv6 literal in brackets; a settings file holds it bare.
    for (const spelling of ['2001:db8::10', '[2001:db8::10]']) {
      expect(headers({
        configuredHost: spelling,
        remoteTokenHost: spelling,
        workerOrigin: 'https://[2001:db8::10]:37777',
        localOrigin: `http://${spelling}:37777`,
      })).toEqual({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
    }
    // Brackets are the only spelling freedom: a different address still gets nothing.
    expect(headers({
      configuredHost: '2001:db8::10',
      remoteTokenHost: '2001:db8::10',
      workerOrigin: 'https://[2001:db8::11]:37777',
      localOrigin: 'http://2001:db8::10:37777',
    })).toEqual({});
  });
});
