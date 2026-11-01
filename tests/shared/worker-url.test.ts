import { describe, expect, it } from 'bun:test';
import { formatHostForUrl } from '../../src/shared/worker-url';

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
