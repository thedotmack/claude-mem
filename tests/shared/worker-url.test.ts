import { describe, expect, it } from 'bun:test';
import { formatHostForUrl, InvalidWorkerUrlError, normalizeWorkerBaseUrl } from '../../src/shared/worker-url';

describe('formatHostForUrl', () => {
  it('brackets a bare IPv6 address', () => {
    expect(formatHostForUrl('::1')).toBe('[::1]');
  });

  it('keeps an already bracketed IPv6 address as is', () => {
    expect(formatHostForUrl('[::1]')).toBe('[::1]');
  });

  for (const host of ['127.0.0.1', 'host.docker.internal', '0.0.0.0']) {
    it(`returns ${host} unchanged`, () => {
      expect(formatHostForUrl(host)).toBe(host);
    });
  }
});

describe('normalizeWorkerBaseUrl', () => {
  it('accepts HTTPS worker URLs and preserves a reverse-proxy path', () => {
    expect(normalizeWorkerBaseUrl(' https://worker.example/mem/ ')).toBe('https://worker.example/mem');
  });

  it('allows loopback HTTP URLs for local workers and port forwards', () => {
    expect(normalizeWorkerBaseUrl('http://127.0.0.1:37777')).toBe('http://127.0.0.1:37777');
    expect(normalizeWorkerBaseUrl('http://[::1]:37777/')).toBe('http://[::1]:37777');
  });

  it('rejects invalid URLs instead of falling back to the host and port', () => {
    expect(() => normalizeWorkerBaseUrl('worker.example:37777')).toThrow('use http or https');
    expect(() => normalizeWorkerBaseUrl('http://[broken')).toThrow('absolute http(s) URL');
    expect(() => normalizeWorkerBaseUrl('file:///tmp/worker')).toThrow('use http or https');
  });

  it('throws a named error, so callers can tell it from an unreachable worker', () => {
    expect(() => normalizeWorkerBaseUrl('http://worker.example')).toThrow(InvalidWorkerUrlError);
    expect(() => normalizeWorkerBaseUrl('not a url')).toThrow(InvalidWorkerUrlError);
  });

  it('requires HTTPS for a non-loopback worker', () => {
    expect(() => normalizeWorkerBaseUrl('http://worker.example:37777')).toThrow('https for non-loopback');
  });

  it('rejects URL credentials and request modifiers', () => {
    expect(() => normalizeWorkerBaseUrl('https://user:secret@worker.example')).toThrow('cannot include credentials');
    expect(() => normalizeWorkerBaseUrl('https://worker.example?token=secret')).toThrow('cannot include credentials');
  });
});


describe('worker base URL delimiters', () => {
  for (const suffix of ['?', '#', '?#', '/mem/?', '/mem/#']) {
    it(`rejects an empty request modifier in ${suffix}`, () => {
      expect(() => normalizeWorkerBaseUrl(`https://worker.example${suffix}`))
        .toThrow(InvalidWorkerUrlError);
    });
  }

  it('preserves encoded question marks and hashes in a proxy path', () => {
    expect(normalizeWorkerBaseUrl('https://worker.example/mem%3F%23/'))
      .toBe('https://worker.example/mem%3F%23');
  });
});
