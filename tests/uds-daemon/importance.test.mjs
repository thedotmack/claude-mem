import { test, expect } from 'bun:test';
import { scoreImportance, shouldAutoPin, deriveToolKind, deriveOutcome } from '../src/lib/importance.mjs';

test('scoreImportance: baseline ~0.3 for a plain read', () => {
  expect(scoreImportance({ toolKind: 'read', outcome: 'success' })).toBeCloseTo(0.2, 1);
});

test('scoreImportance: failure boosts substantially', () => {
  const s = scoreImportance({ toolKind: 'bash', outcome: 'failure', text: 'Error: exit code: 1' });
  expect(s).toBeGreaterThan(0.7);
});

test('scoreImportance: edit + git-tracked is high', () => {
  expect(scoreImportance({ toolKind: 'edit', outcome: 'success', isGitTracked: true })).toBeGreaterThan(0.4);
});

test('scoreImportance: clamped 0..1', () => {
  const s = scoreImportance({
    toolKind: 'edit', outcome: 'failure', isExplicitUserAsk: true, isGitTracked: true,
    text: 'Error: exception panic crashed',
  });
  expect(s).toBeLessThanOrEqual(1);
  expect(s).toBeGreaterThan(0.9);
});

test('shouldAutoPin: catches ADR-style markers', () => {
  expect(shouldAutoPin('decision: we use UDS sockets')).toBe(true);
  expect(shouldAutoPin('we chose Postgres over MySQL because of FTS5')).toBe(true);
  expect(shouldAutoPin('adopted Bun runtime for hot path')).toBe(true);
  expect(shouldAutoPin('MUST NOT use --no-verify')).toBe(true);
  expect(shouldAutoPin('ADR-0042 documented the choice')).toBe(true);
});

test('shouldAutoPin: ignores non-decision text', () => {
  expect(shouldAutoPin('just a routine refactor')).toBe(false);
  expect(shouldAutoPin('echo hello world')).toBe(false);
  expect(shouldAutoPin('')).toBe(false);
});

test('deriveToolKind: maps tool names', () => {
  expect(deriveToolKind('Bash')).toBe('bash');
  expect(deriveToolKind('Edit')).toBe('edit');
  expect(deriveToolKind('MultiEdit')).toBe('edit');
  expect(deriveToolKind('Read')).toBe('read');
  expect(deriveToolKind('Task')).toBe('task');
  expect(deriveToolKind('UnknownTool')).toBe('unknown');
});

test('deriveOutcome: maps response shapes', () => {
  expect(deriveOutcome({ exitCode: 0, stdout: 'ok' })).toBe('success');
  expect(deriveOutcome({ exitCode: 1 })).toBe('failure');
  expect(deriveOutcome({ error: 'oops' })).toBe('failure');
  expect(deriveOutcome({ success: false })).toBe('failure');
  expect(deriveOutcome(null)).toBe('unknown');
});
