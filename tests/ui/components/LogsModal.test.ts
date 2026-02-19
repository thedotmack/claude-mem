/**
 * Tests for parseLogLine — the regex-based structured log parser
 * exported from LogsModal.tsx.
 */

import { describe, it, expect } from 'vitest';
import { parseLogLine } from '../../../src/ui/viewer/components/LogsModal';

describe('parseLogLine', () => {
  // ─── Standard log lines ──────────────────────────────

  it('parses a standard log line with all fields', () => {
    const line = '[2025-01-02 14:30:45.123] [INFO ] [WORKER] [session-123] Started processing';
    const result = parseLogLine(line);

    expect(result.timestamp).toBe('2025-01-02 14:30:45.123');
    expect(result.level).toBe('INFO');
    expect(result.component).toBe('WORKER');
    expect(result.correlationId).toBe('session-123');
    expect(result.message).toBe('Started processing');
    expect(result.raw).toBe(line);
  });

  it('parses a log line without correlation ID', () => {
    const line = '[2025-01-02 14:30:45.123] [INFO ] [WORKER] Server started on port 37777';
    const result = parseLogLine(line);

    expect(result.timestamp).toBe('2025-01-02 14:30:45.123');
    expect(result.level).toBe('INFO');
    expect(result.component).toBe('WORKER');
    expect(result.correlationId).toBeUndefined();
    expect(result.message).toBe('Server started on port 37777');
  });

  it('handles DEBUG level with padding', () => {
    const line = '[2025-01-02 14:30:45.123] [DEBUG] [DB] [q-001] Query executed in 12ms';
    const result = parseLogLine(line);

    expect(result.level).toBe('DEBUG');
    expect(result.component).toBe('DB');
  });

  it('handles WARN level', () => {
    const line = '[2025-01-02 14:30:45.123] [WARN ] [HTTP] Rate limit approaching';
    const result = parseLogLine(line);

    expect(result.level).toBe('WARN');
    expect(result.component).toBe('HTTP');
  });

  it('handles ERROR level', () => {
    const line = '[2025-01-02 14:30:45.123] [ERROR] [SDK] Connection refused';
    const result = parseLogLine(line);

    expect(result.level).toBe('ERROR');
    expect(result.component).toBe('SDK');
  });

  // ─── Special message detection ───────────────────────

  it('detects data-in arrow (→)', () => {
    const line = '[2025-01-02 14:30:45.123] [INFO ] [WORKER] → Received payload';
    const result = parseLogLine(line);
    expect(result.isSpecial).toBe('dataIn');
  });

  it('detects data-out arrow (←)', () => {
    const line = '[2025-01-02 14:30:45.123] [INFO ] [WORKER] ← Sent response';
    const result = parseLogLine(line);
    expect(result.isSpecial).toBe('dataOut');
  });

  it('detects success checkmark (✓)', () => {
    const line = '[2025-01-02 14:30:45.123] [INFO ] [WORKER] ✓ Task completed';
    const result = parseLogLine(line);
    expect(result.isSpecial).toBe('success');
  });

  it('detects failure cross (✗)', () => {
    const line = '[2025-01-02 14:30:45.123] [ERROR] [WORKER] ✗ Task failed';
    const result = parseLogLine(line);
    expect(result.isSpecial).toBe('failure');
  });

  it('detects timing (⏱)', () => {
    const line = '[2025-01-02 14:30:45.123] [INFO ] [WORKER] ⏱ 42ms elapsed';
    const result = parseLogLine(line);
    expect(result.isSpecial).toBe('timing');
  });

  it('detects happy-path tag', () => {
    const line = '[2025-01-02 14:30:45.123] [INFO ] [WORKER] Processing [HAPPY-PATH] observation';
    const result = parseLogLine(line);
    expect(result.isSpecial).toBe('happyPath');
  });

  it('returns undefined isSpecial for regular messages', () => {
    const line = '[2025-01-02 14:30:45.123] [INFO ] [WORKER] Regular message';
    const result = parseLogLine(line);
    expect(result.isSpecial).toBeUndefined();
  });

  // ─── Non-matching lines (fallback to raw) ────────────

  it('returns raw-only for lines that do not match the pattern', () => {
    const line = 'This is just a plain text line';
    const result = parseLogLine(line);

    expect(result.raw).toBe(line);
    expect(result.timestamp).toBeUndefined();
    expect(result.level).toBeUndefined();
    expect(result.component).toBeUndefined();
    expect(result.message).toBeUndefined();
  });

  it('returns raw-only for empty string', () => {
    const result = parseLogLine('');
    expect(result.raw).toBe('');
    expect(result.timestamp).toBeUndefined();
  });

  it('returns raw-only for line with only opening bracket', () => {
    const result = parseLogLine('[incomplete');
    expect(result.raw).toBe('[incomplete');
    expect(result.timestamp).toBeUndefined();
  });

  it('returns raw-only for partial bracket pattern', () => {
    const line = '[2025-01-02] some text without proper format';
    const result = parseLogLine(line);
    expect(result.raw).toBe(line);
    expect(result.timestamp).toBeUndefined();
  });

  // ─── Edge cases ──────────────────────────────────────

  it('handles empty message after brackets', () => {
    const line = '[2025-01-02 14:30:45.123] [INFO ] [WORKER] ';
    const result = parseLogLine(line);

    expect(result.timestamp).toBe('2025-01-02 14:30:45.123');
    expect(result.message).toBe('');
  });

  it('handles message with special characters', () => {
    const line = '[2025-01-02 14:30:45.123] [INFO ] [HTTP] GET /api/data?q=test&limit=10 → 200';
    const result = parseLogLine(line);

    expect(result.message).toBe('GET /api/data?q=test&limit=10 → 200');
    expect(result.isSpecial).toBeUndefined(); // → is not at message start
  });

  it('handles correlation ID with special characters', () => {
    const line = '[2025-01-02 14:30:45.123] [INFO ] [WORKER] [sess-abc-123-def] Done';
    const result = parseLogLine(line);

    expect(result.correlationId).toBe('sess-abc-123-def');
  });
});
