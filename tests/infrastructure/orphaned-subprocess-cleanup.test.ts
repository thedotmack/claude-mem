/**
 * Tests for orphaned Claude subprocess cleanup
 *
 * Tests the cleanupOrphanedClaudeSubprocesses function that kills zombie
 * Claude processes that accumulate when Agent SDK queries hang or abort.
 *
 * @see https://github.com/thedotmack/claude-mem/issues/737
 */

import { describe, it, expect } from 'bun:test';

// Test the etime parsing helper functions (extracted for testing)
// These are the same algorithms used in ProcessManager.ts

/**
 * Parse Unix etime format to minutes
 * Formats: SS, MM:SS, HH:MM:SS, D-HH:MM:SS
 */
function parseEtimeToMinutes(etime: string): number {
  try {
    // Handle day format: D-HH:MM:SS
    if (etime.includes('-')) {
      const [dayPart, timePart] = etime.split('-');
      const days = parseInt(dayPart, 10);
      const timeMinutes = parseTimeToMinutes(timePart);
      return days * 24 * 60 + timeMinutes;
    }
    return parseTimeToMinutes(etime);
  } catch {
    return 0;
  }
}

/**
 * Parse HH:MM:SS or MM:SS or SS to minutes
 */
function parseTimeToMinutes(time: string): number {
  if (!time || time.trim() === '') return 0;
  const parts = time.split(':').map(p => parseInt(p, 10));
  // Check for NaN values
  if (parts.some(p => isNaN(p))) return 0;
  if (parts.length === 3) {
    // HH:MM:SS
    return parts[0] * 60 + parts[1] + parts[2] / 60;
  } else if (parts.length === 2) {
    // MM:SS
    return parts[0] + parts[1] / 60;
  } else if (parts.length === 1) {
    // SS
    return parts[0] / 60;
  }
  return 0;
}

describe('OrphanedSubprocessCleanup', () => {
  describe('parseEtimeToMinutes', () => {
    it('should parse SS format', () => {
      expect(parseEtimeToMinutes('30')).toBeCloseTo(0.5, 2);
      expect(parseEtimeToMinutes('60')).toBeCloseTo(1, 2);
      expect(parseEtimeToMinutes('90')).toBeCloseTo(1.5, 2);
    });

    it('should parse MM:SS format', () => {
      expect(parseEtimeToMinutes('05:00')).toBe(5);
      expect(parseEtimeToMinutes('30:00')).toBe(30);
      expect(parseEtimeToMinutes('45:30')).toBeCloseTo(45.5, 2);
    });

    it('should parse HH:MM:SS format', () => {
      expect(parseEtimeToMinutes('01:00:00')).toBe(60);
      expect(parseEtimeToMinutes('02:30:00')).toBe(150);
      expect(parseEtimeToMinutes('00:45:00')).toBe(45);
    });

    it('should parse D-HH:MM:SS format (days)', () => {
      expect(parseEtimeToMinutes('1-00:00:00')).toBe(24 * 60); // 1 day = 1440 minutes
      expect(parseEtimeToMinutes('2-12:00:00')).toBe(2 * 24 * 60 + 12 * 60); // 2.5 days
      expect(parseEtimeToMinutes('3-06:30:00')).toBe(3 * 24 * 60 + 6 * 60 + 30); // 3 days + 6.5 hours
    });

    it('should return 0 for invalid formats', () => {
      expect(parseEtimeToMinutes('')).toBe(0);
      expect(parseEtimeToMinutes('invalid')).toBe(0);
    });

    it('should handle zombie process age correctly', () => {
      // 30 minutes is the default threshold
      const threshold = 30;

      // These should be killed (>= 30 minutes)
      expect(parseEtimeToMinutes('30:00')).toBeGreaterThanOrEqual(threshold);
      expect(parseEtimeToMinutes('31:00')).toBeGreaterThanOrEqual(threshold);
      expect(parseEtimeToMinutes('01:00:00')).toBeGreaterThanOrEqual(threshold);
      expect(parseEtimeToMinutes('1-00:00:00')).toBeGreaterThanOrEqual(threshold);

      // These should NOT be killed (< 30 minutes)
      expect(parseEtimeToMinutes('29:00')).toBeLessThan(threshold);
      expect(parseEtimeToMinutes('15:00')).toBeLessThan(threshold);
      expect(parseEtimeToMinutes('05:00')).toBeLessThan(threshold);
    });
  });

  describe('parseTimeToMinutes', () => {
    it('should handle edge cases', () => {
      expect(parseTimeToMinutes('00:00')).toBe(0);
      expect(parseTimeToMinutes('00:00:00')).toBe(0);
    });

    it('should handle max realistic values', () => {
      // 59:59 (almost an hour)
      expect(parseTimeToMinutes('59:59')).toBeCloseTo(59 + 59/60, 2);

      // 23:59:59 (almost a day)
      expect(parseTimeToMinutes('23:59:59')).toBeCloseTo(23 * 60 + 59 + 59/60, 2);
    });
  });

  describe('cleanup behavior', () => {
    it('should only kill orphaned processes with ppid==1 (Unix)', () => {
      // Simulated ps output with ppid column: pid ppid etime args
      // On Unix, orphaned processes are re-parented to init (PID 1)
      const testLines = [
        '12345 1 30:00 /usr/local/bin/claude --model claude-haiku-4-5 --orphaned',      // ppid=1, old -> KILL
        '12346 1 05:00 /usr/local/bin/claude --model claude-haiku-4-5 --young',         // ppid=1, young -> skip
        '12347 5678 45:00 /usr/local/bin/claude --model claude-haiku-4-5 --active',     // ppid!=1, old -> skip (not orphaned)
        '12348 1 1-12:00:00 /usr/local/bin/claude --model claude-haiku-4-5 --zombie',   // ppid=1, very old -> KILL
        '12349 9999 30:00 /usr/local/bin/claude --model claude-haiku-4-5 --legitimate', // ppid!=1 -> skip (active session)
      ];

      const maxAgeMinutes = 30;
      const processesToKill: { pid: number; ppid: number; etime: string }[] = [];

      for (const line of testLines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;

        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        const etime = parts[2];
        const args = parts.slice(3).join(' ');

        // Check if it matches claude haiku pattern
        if (!args.includes('claude') || !args.includes('haiku')) continue;

        // Only target orphaned processes (ppid==1)
        if (ppid !== 1) continue;

        const ageMinutes = parseEtimeToMinutes(etime);
        if (ageMinutes >= maxAgeMinutes) {
          processesToKill.push({ pid, ppid, etime });
        }
      }

      // Should only kill orphaned processes (ppid==1) that are old enough
      // 12345 (ppid=1, 30:00) and 12348 (ppid=1, 1-12:00:00)
      // NOT 12347 or 12349 (ppid!=1, even though old enough)
      expect(processesToKill.length).toBe(2);
      expect(processesToKill[0].pid).toBe(12345);
      expect(processesToKill[0].ppid).toBe(1);
      expect(processesToKill[1].pid).toBe(12348);
      expect(processesToKill[1].ppid).toBe(1);
    });

    it('should preserve legitimate Claude sessions from other tools (ppid != 1)', () => {
      // These processes have living parents (ppid != 1)
      // They should NOT be killed even if they match the pattern and are old
      const testLines = [
        '12345 5678 45:00 /usr/local/bin/claude --model claude-haiku-4-5 --from-vscode',
        '12346 9012 1-00:00:00 /usr/local/bin/claude --model claude-haiku-4-5 --from-terminal',
        '12347 3456 02:00:00 /usr/local/bin/claude --model claude-haiku-4-5 --from-other-tool',
      ];

      const maxAgeMinutes = 30;
      const processesToKill: { pid: number; ppid: number; etime: string }[] = [];

      for (const line of testLines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;

        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        const etime = parts[2];

        // Only target orphaned processes (ppid==1)
        if (ppid !== 1) continue;

        const ageMinutes = parseEtimeToMinutes(etime);
        if (ageMinutes >= maxAgeMinutes) {
          processesToKill.push({ pid, ppid, etime });
        }
      }

      // None should be killed - all have living parents
      expect(processesToKill.length).toBe(0);
    });

    it('should identify processes matching haiku pattern (legacy test)', () => {
      // Legacy test format without ppid - kept for parseEtimeToMinutes coverage
      const testLines = [
        '12345 30:00 /usr/local/bin/claude --model claude-haiku-4-5 --something',
        '12346 05:00 /usr/local/bin/claude --model claude-haiku-4-5 --other',
        '12347 45:00 /usr/local/bin/node some-other-process',
        '12348 1-12:00:00 /usr/local/bin/claude --model claude-haiku-4-5 --old',
      ];

      const maxAgeMinutes = 30;
      const processesToKill: { pid: number; etime: string }[] = [];

      for (const line of testLines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;

        const pid = parseInt(parts[0], 10);
        const etime = parts[1];
        const args = parts.slice(2).join(' ');

        // Check if it matches claude haiku pattern
        if (!args.includes('claude') || !args.includes('haiku')) continue;

        const ageMinutes = parseEtimeToMinutes(etime);
        if (ageMinutes >= maxAgeMinutes) {
          processesToKill.push({ pid, etime });
        }
      }

      // Should identify processes 12345 (30:00) and 12348 (1-12:00:00)
      expect(processesToKill.length).toBe(2);
      expect(processesToKill[0].pid).toBe(12345);
      expect(processesToKill[1].pid).toBe(12348);
    });

    it('should respect age threshold', () => {
      const testCases = [
        { etime: '29:59', maxAge: 30, shouldKill: false },
        { etime: '30:00', maxAge: 30, shouldKill: true },
        { etime: '30:01', maxAge: 30, shouldKill: true },
        { etime: '05:00', maxAge: 5, shouldKill: true },
        { etime: '04:59', maxAge: 5, shouldKill: false },
      ];

      for (const { etime, maxAge, shouldKill } of testCases) {
        const ageMinutes = parseEtimeToMinutes(etime);
        const result = ageMinutes >= maxAge;
        expect(result).toBe(shouldKill);
      }
    });
  });
});
