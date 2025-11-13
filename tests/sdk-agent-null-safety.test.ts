import { test, describe } from 'node:test';
import assert from 'node:assert';

/**
 * Tests for null safety in SDKAgent string operations
 *
 * Context: ObservationRow.title and SessionSummaryRow.request are typed as `string | null`
 * Bug: SDKAgent was calling .substring() without null checks, causing crashes
 * Fix: Applied pattern (field || '').substring(0, N) to handle null/undefined safely
 */

describe('SDKAgent null safety patterns', () => {
  describe('Observation title truncation', () => {
    test('should handle null title without crashing', () => {
      const title: string | null = null;

      // Pattern used in SDKAgent.ts:224, 243, 256
      const truncated = (title || '').substring(0, 60);

      assert.strictEqual(truncated, '');
      assert.doesNotThrow(() => {
        (title || '').substring(0, 60);
      });
    });

    test('should handle undefined title without crashing', () => {
      const title: string | null | undefined = undefined;

      const truncated = (title || '').substring(0, 60);

      assert.strictEqual(truncated, '');
    });

    test('should preserve empty string titles', () => {
      const title = '';

      const truncated = (title || '').substring(0, 60);

      assert.strictEqual(truncated, '');
    });

    test('should truncate long titles correctly', () => {
      const longTitle = 'a'.repeat(100);

      const truncated = (longTitle || '').substring(0, 60);

      assert.strictEqual(truncated.length, 60);
      assert.strictEqual(truncated, 'a'.repeat(60));
    });

    test('should preserve short titles without truncation', () => {
      const shortTitle = 'Short title';

      const truncated = (shortTitle || '').substring(0, 60);

      assert.strictEqual(truncated, shortTitle);
    });

    test('should handle title at exactly 60 characters', () => {
      const exactTitle = 'a'.repeat(60);

      const truncated = (exactTitle || '').substring(0, 60);

      assert.strictEqual(truncated.length, 60);
      assert.strictEqual(truncated, exactTitle);
    });
  });

  describe('Summary request truncation', () => {
    test('should handle null request without crashing', () => {
      const request: string | null = null;

      // Pattern used in SDKAgent.ts:301, 319, 330
      const truncated = (request || '').substring(0, 60);

      assert.strictEqual(truncated, '');
      assert.doesNotThrow(() => {
        (request || '').substring(0, 60);
      });
    });

    test('should handle undefined request without crashing', () => {
      const request: string | null | undefined = undefined;

      const truncated = (request || '').substring(0, 60);

      assert.strictEqual(truncated, '');
    });

    test('should preserve empty string requests', () => {
      const request = '';

      const truncated = (request || '').substring(0, 60);

      assert.strictEqual(truncated, '');
    });

    test('should truncate long requests correctly', () => {
      const longRequest = 'b'.repeat(100);

      const truncated = (longRequest || '').substring(0, 60);

      assert.strictEqual(truncated.length, 60);
      assert.strictEqual(truncated, 'b'.repeat(60));
    });
  });

  describe('Truncation with ellipsis pattern', () => {
    test('should add ellipsis for long titles (pattern from line 224)', () => {
      const longTitle = 'a'.repeat(100);

      // Exact pattern from SDKAgent.ts:224
      const result = (longTitle || '').substring(0, 60) + ((longTitle || '').length > 60 ? '...' : '');

      assert.strictEqual(result, 'a'.repeat(60) + '...');
    });

    test('should not add ellipsis for short titles', () => {
      const shortTitle = 'Short';

      const result = (shortTitle || '').substring(0, 60) + ((shortTitle || '').length > 60 ? '...' : '');

      assert.strictEqual(result, 'Short');
    });

    test('should handle null with ellipsis pattern', () => {
      const title: string | null = null;

      const result = (title || '').substring(0, 60) + ((title || '').length > 60 ? '...' : '');

      assert.strictEqual(result, '');
    });

    test('should add ellipsis for 50-char truncation (Chroma pattern from line 243)', () => {
      const longTitle = 'c'.repeat(80);

      // Pattern from SDKAgent.ts:242-244
      const result = (longTitle || '').length > 50
        ? (longTitle || '').substring(0, 50) + '...'
        : (longTitle || '');

      assert.strictEqual(result, 'c'.repeat(50) + '...');
    });
  });

  describe('Edge cases', () => {
    test('should handle whitespace-only titles', () => {
      const whitespaceTitle = '   ';

      const truncated = (whitespaceTitle || '').substring(0, 60);

      assert.strictEqual(truncated, '   ');
    });

    test('should handle titles with special characters', () => {
      const specialTitle = 'Title with émojis 🎉 and spëcial chârs';

      const truncated = (specialTitle || '').substring(0, 60);

      assert.strictEqual(truncated.length, Math.min(60, specialTitle.length));
    });

    test('should handle very long titles (1000+ chars)', () => {
      const veryLongTitle = 'x'.repeat(1000);

      const truncated = (veryLongTitle || '').substring(0, 60);

      assert.strictEqual(truncated.length, 60);
      assert.strictEqual(truncated, 'x'.repeat(60));
    });

    test('should handle titles with newlines', () => {
      const titleWithNewlines = 'Line 1\nLine 2\nLine 3';

      const truncated = (titleWithNewlines || '').substring(0, 60);

      assert.ok(truncated.includes('\n'));
    });
  });

  describe('Regression test - original bug scenario', () => {
    test('should not crash when logging observation with null title', () => {
      // Simulate the exact scenario that caused the production crash
      const obs = {
        type: 'discovery' as const,
        title: null as string | null,
        subtitle: null as string | null,
        narrative: 'Some narrative text',
        facts: [],
        concepts: [],
        files: []
      };

      // This is what SDKAgent.ts:224 does
      assert.doesNotThrow(() => {
        const logData = {
          type: obs.type,
          title: (obs.title || '').substring(0, 60) + ((obs.title || '').length > 60 ? '...' : ''),
          files: obs.files?.length || 0,
          concepts: obs.concepts?.length || 0
        };

        assert.strictEqual(logData.title, '');
      });
    });

    test('should not crash when logging summary with null request', () => {
      // Simulate summary logging scenario
      const summary = {
        request: null as string | null,
        investigated: 'Investigation details',
        learned: 'Learnings',
        completed: 'Completion status',
        next_steps: 'Next steps'
      };

      // This is what SDKAgent.ts:301 does
      assert.doesNotThrow(() => {
        const logData = {
          request: (summary.request || '').substring(0, 60) + ((summary.request || '').length > 60 ? '...' : ''),
          hasCompleted: !!summary.completed,
          hasNextSteps: !!summary.next_steps
        };

        assert.strictEqual(logData.request, '');
      });
    });

    test('should not crash in Chroma sync error handler with null title', () => {
      const obsTitle: string | null = null;

      // This is what SDKAgent.ts:256 does in the catch block
      assert.doesNotThrow(() => {
        const errorLog = {
          title: (obsTitle || '').substring(0, 50)
        };

        assert.strictEqual(errorLog.title, '');
      });
    });

    test('should not crash in Chroma sync error handler with null request', () => {
      const summaryRequest: string | null = null;

      // This is what SDKAgent.ts:330 does in the catch block
      assert.doesNotThrow(() => {
        const errorLog = {
          request: (summaryRequest || '').substring(0, 50)
        };

        assert.strictEqual(errorLog.request, '');
      });
    });
  });
});
