import { describe, expect, it } from 'bun:test';
import { isSafeBrowserUrl } from '../../src/npx-cli/utils/browser-url.js';

describe('isSafeBrowserUrl', () => {
  it('accepts http and https urls', () => {
    expect(isSafeBrowserUrl('https://cmem.ai/pro')).toBe(true);
    expect(isSafeBrowserUrl('http://127.0.0.1:37777/viewer?token=abc')).toBe(true);
  });

  it('rejects non-http schemes and malformed values', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'not a url',
      '',
    ]) {
      expect(isSafeBrowserUrl(url)).toBe(false);
    }
  });
});