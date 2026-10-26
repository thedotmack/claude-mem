import { expect, it } from 'bun:test';
import { classifySyncAuthFailure } from '../../src/shared/sync-health.js';

it('does not pause token authentication for a commented HTML proxy refusal', () => {
  const html = '<!-- proxy diagnostic -->\n<!DOCTYPE html><html><body>Access denied</body></html>';
  expect(classifySyncAuthFailure(403, html)).toBeNull();
  expect(classifySyncAuthFailure(401, html)).toBeNull();
});
it('still recognizes a JSON auth refusal containing comment-shaped detail', () => {
  expect(classifySyncAuthFailure(401, JSON.stringify({ code: 'invalid_token', message: '<!-- diagnostic -->' }))?.code).toBe('invalid_token');
});
