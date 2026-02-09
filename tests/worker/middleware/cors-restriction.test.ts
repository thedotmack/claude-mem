/**
 * CORS Restriction Tests
 *
 * Verifies that CORS is properly restricted to localhost origins only.
 * This prevents cross-origin attacks from malicious websites.
 */

import { describe, it, expect } from 'bun:test';

// Test the CORS origin validation logic directly
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // No origin = hooks, curl, CLI
  if (origin.startsWith('http://localhost:')) return true;
  if (origin.startsWith('http://127.0.0.1:')) return true;
  return false;
}

describe('CORS Restriction', () => {
  describe('allowed origins', () => {
    it('allows requests without Origin header (hooks, curl, CLI)', () => {
      expect(isAllowedOrigin(undefined)).toBe(true);
    });

    it('allows localhost with port', () => {
      expect(isAllowedOrigin('http://localhost:37777')).toBe(true);
      expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
      expect(isAllowedOrigin('http://localhost:8080')).toBe(true);
    });

    it('allows 127.0.0.1 with port', () => {
      expect(isAllowedOrigin('http://127.0.0.1:37777')).toBe(true);
      expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true);
    });
  });

  describe('blocked origins', () => {
    it('blocks external domains', () => {
      expect(isAllowedOrigin('http://evil.com')).toBe(false);
      expect(isAllowedOrigin('https://attacker.io')).toBe(false);
      expect(isAllowedOrigin('http://malicious-site.net:8080')).toBe(false);
    });

    it('blocks HTTPS localhost (not typically used for local dev)', () => {
      // HTTPS localhost is unusual and could indicate a proxy attack
      expect(isAllowedOrigin('https://localhost:37777')).toBe(false);
    });

    it('blocks localhost-like domains (subdomain attacks)', () => {
      expect(isAllowedOrigin('http://localhost.evil.com')).toBe(false);
      expect(isAllowedOrigin('http://localhost.attacker.io:8080')).toBe(false);
    });

    it('blocks file:// origins', () => {
      expect(isAllowedOrigin('file://')).toBe(false);
    });

    it('blocks null origin', () => {
      // null origin can come from sandboxed iframes
      expect(isAllowedOrigin('null')).toBe(false);
    });
  });
});
