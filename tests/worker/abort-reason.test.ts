import { describe, expect, it } from 'bun:test';
import {
  abortCategoryOf,
  normalizeAbortReason,
  PRESERVING_ABORT_CATEGORIES,
} from '../../src/services/worker/session/abort-reason.js';

describe('abort reason authority', () => {
  it('owns the preserving categories', () => {
    expect([...PRESERVING_ABORT_CATEGORIES]).toEqual(['quota', 'auth', 'drift']);
  });

  it('extracts categories without exposing provider text', () => {
    expect(abortCategoryOf('drift:observer_schema')).toBe('drift');
    expect(abortCategoryOf('quota:provider message')).toBe('quota');
    expect(abortCategoryOf(null)).toBe('');
  });

  it('normalizes the closed telemetry enum', () => {
    expect(normalizeAbortReason('idle')).toBe('idle');
    expect(normalizeAbortReason('shutdown:worker')).toBe('shutdown');
    expect(normalizeAbortReason('overflow:queue')).toBe('overflow');
    expect(normalizeAbortReason('restart-guard:limit')).toBe('restart_guard');
    expect(normalizeAbortReason('quota:observer_text')).toBe('quota');
    expect(normalizeAbortReason('drift:observer_schema')).toBe('drift');
    expect(normalizeAbortReason(null)).toBe('none');
    expect(normalizeAbortReason('unknown:raw text')).toBe('none');
  });
});
