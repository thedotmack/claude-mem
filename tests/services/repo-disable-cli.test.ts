/**
 * Tests for repo disable/enable helper functions
 * Source: src/services/worker-service.ts
 */

import { describe, it, expect } from 'bun:test';
import { addToExcluded, removeFromExcluded } from '../../src/utils/repo-exclude-utils.js';

describe('addToExcluded', () => {
  it('adds a path to empty string', () => {
    expect(addToExcluded('', '/path/to/repo')).toBe('/path/to/repo');
  });

  it('adds a path to existing patterns', () => {
    expect(addToExcluded('/other/repo', '/path/to/repo')).toBe('/other/repo,/path/to/repo');
  });

  it('does not duplicate if already present', () => {
    expect(addToExcluded('/path/to/repo', '/path/to/repo')).toBe('/path/to/repo');
  });
});

describe('removeFromExcluded', () => {
  it('removes a path from patterns', () => {
    expect(removeFromExcluded('/path/to/repo', '/path/to/repo')).toBe('');
  });

  it('removes only the matching path', () => {
    expect(removeFromExcluded('/other/repo,/path/to/repo', '/path/to/repo')).toBe('/other/repo');
  });

  it('returns unchanged if path not found', () => {
    expect(removeFromExcluded('/other/repo', '/path/to/repo')).toBe('/other/repo');
  });
});
