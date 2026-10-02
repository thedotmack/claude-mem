import { describe, it, expect, spyOn } from 'bun:test';
import {
  optimizeField,
  optimizeObservationFields,
  buildFieldCompressionPrompt,
  FIELD_OPTIMIZE_TIMEOUT_MS,
  type FieldCompressor,
} from '../../src/services/worker/field-optimizer.js';
import { logger } from '../../src/utils/logger.js';
import {
  condenseInputMaxTokens,
  estimateCondenseTokens,
  FALLBACK_CONTEXT_WINDOW_TOKENS,
} from '../../src/services/worker/context-window.js';

const CTX = { sessionDbId: 1, field: 'outcome', toolName: 'Read' };
const MAX = 200;

/** A payload comfortably over `MAX` once stringified. */
const oversized = { body: 'x'.repeat(MAX * 3) };

describe('oversized observation fields are condensed, not cut (#3800)', () => {
  it('leaves a field that already fits untouched, and never calls the model', async () => {
    let calls = 0;
    const compress: FieldCompressor = async () => { calls++; return 'nope'; };

    const value = { small: 'fits' };
    expect(await optimizeField(value, compress, CTX, MAX)).toBe(value);
    expect(calls).toBe(0);
  });

  it('replaces an oversized field with a condensed summary of the whole field', async () => {
    const compress: FieldCompressor = async () => 'the file defines 3 helpers and exits 0';

    const out = await optimizeField(oversized, compress, CTX, MAX) as string;

    expect(out).toContain('the file defines 3 helpers and exits 0');
    // Marked condensed rather than elided: it summarises everything, so the
    // observer must not treat it as a fragment with a hole in it.
    expect(out).toContain('<condensed');
    expect(out).not.toContain('<elided');
    expect(out.length).toBeLessThanOrEqual(MAX);
  });

  it('asks for a budget under the cap so a slightly-long reply still fits', async () => {
    let asked = -1;
    const compress: FieldCompressor = async (_t, budget) => { asked = budget; return 'ok'; };

    await optimizeField(oversized, compress, CTX, MAX);
    expect(asked).toBeLessThan(MAX);
    expect(asked).toBeGreaterThan(0);
  });

  it('falls back to the original (so truncation still applies) when the model returns nothing', async () => {
    const compress: FieldCompressor = async () => null;
    expect(await optimizeField(oversized, compress, CTX, MAX)).toBe(oversized);
  });

  it('falls back when the model returns something still over budget', async () => {
    const compress: FieldCompressor = async () => 'y'.repeat(MAX * 2);
    expect(await optimizeField(oversized, compress, CTX, MAX)).toBe(oversized);
  });

  it('falls back when the model throws, rather than losing the observation', async () => {
    const compress: FieldCompressor = async () => { throw new Error('gateway down'); };
    expect(await optimizeField(oversized, compress, CTX, MAX)).toBe(oversized);
  });

  it('gives up on a compressor that outlasts the supplied deadline, then truncation applies', async () => {
    // A compressor slower than the deadline: the pass aborts and returns the
    // original so the caller's truncation still runs (#4134). Resolving on a
    // real backend that needs more than the deadline is exactly this case.
    const compress: FieldCompressor = (_t, _b, signal) =>
      new Promise(resolve => {
        signal.addEventListener('abort', () => resolve(null), { once: true });
      });

    const out = await optimizeField(oversized, compress, CTX, MAX, 20);
    expect(out).toBe(oversized);
  });

  it('condenses within a generous deadline instead of timing out', async () => {
    const compress: FieldCompressor = async () => 'condensed under a roomy deadline';
    const out = await optimizeField(oversized, compress, CTX, MAX, 10_000) as string;
    expect(out).toContain('condensed under a roomy deadline');
  });

  it('resolves a lazy deadline only when a field is actually oversized', async () => {
    // The providers pass resolveFieldOptimizeTimeoutMs (which reads settings.json
    // from disk); it must stay unread on the common turn where everything fits.
    let resolved = 0;
    const timeout = () => { resolved++; return 10_000; };
    const compress: FieldCompressor = async () => 'condensed';

    expect(await optimizeField({ small: 'fits' }, compress, CTX, MAX, timeout)).toEqual({ small: 'fits' });
    expect(resolved).toBe(0);

    await optimizeField(oversized, compress, CTX, MAX, timeout);
    expect(resolved).toBe(1);
  });

  it('tries once per field — a failure never becomes a retry ladder', async () => {
    let calls = 0;
    const compress: FieldCompressor = async () => { calls++; return null; };

    await optimizeField(oversized, compress, CTX, MAX);
    expect(calls).toBe(1);
  });

  it('condenses both payload fields independently', async () => {
    const compress: FieldCompressor = async text =>
      text.includes('IN') ? 'condensed input' : 'condensed output';

    const out = await optimizeObservationFields(
      { toolInput: { body: 'IN'.repeat(MAX * 2) }, toolOutput: oversized },
      compress,
      { sessionDbId: 1, toolName: 'Bash' },
      MAX,
    );

    expect(String(out.toolInput)).toContain('condensed input');
    expect(String(out.toolOutput)).toContain('condensed output');
  });

  it('only condenses the field that is actually oversized', async () => {
    const compress: FieldCompressor = async () => 'condensed';
    const small = { ok: 1 };

    const out = await optimizeObservationFields(
      { toolInput: small, toolOutput: oversized },
      compress,
      { sessionDbId: 1 },
      MAX,
    );

    expect(out.toolInput).toBe(small);
    expect(String(out.toolOutput)).toContain('condensed');
  });

  it('tells the model to keep the signal and return the payload only', () => {
    const prompt = buildFieldCompressionPrompt('some payload', 500);
    expect(prompt).toContain('500');
    expect(prompt).toContain('some payload');
    expect(prompt).toContain('file paths');
    expect(prompt).toContain('no code');
  });
});

describe('a field too large for the observer model\'s condense prompt skips the model call', () => {
  // ~70k chars: over what a 32k-token window can take in one condense prompt,
  // well within what a 1M-token window can.
  const huge = { body: 'x'.repeat(70_000) };
  const prose = (chars: number) => 'the quick brown fox jumps over the lazy dog '.repeat(Math.ceil(chars / 44)).slice(0, chars);

  it('falls through to truncation without calling the model, and warns once with the token sizes', async () => {
    let calls = 0;
    const compress: FieldCompressor = async () => { calls++; return 'condensed'; };
    const warn = spyOn(logger, 'warn');
    try {
      expect(await optimizeField(huge, compress, CTX, MAX, FIELD_OPTIMIZE_TIMEOUT_MS, 32_768)).toBe(huge);
      expect(calls).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      const fields = warn.mock.calls[0][2] as Record<string, unknown>;
      expect(fields.estimatedTokens).toBe(estimateCondenseTokens(JSON.stringify(huge, null, 2)));
      expect(fields.maxTokens).toBe(condenseInputMaxTokens(32_768));
    } finally {
      warn.mockRestore();
    }
  });

  it('condenses the same field when the observer window can take it', async () => {
    let calls = 0;
    const compress: FieldCompressor = async () => { calls++; return 'condensed'; };

    const out = await optimizeField(huge, compress, CTX, MAX, FIELD_OPTIMIZE_TIMEOUT_MS, 1_000_000) as string;
    expect(calls).toBe(1);
    expect(out).toContain('condensed');
  });

  it('judges a 1M-token window by tokens: dense 1.5M chars is not sent, prose 1.5M chars is', async () => {
    // greptile's case: a dense payload under the 2M-char ceiling became a
    // 1.02M-token request the model rejected.
    let calls = 0;
    const compress: FieldCompressor = async () => { calls++; return 'condensed'; };
    const dense = { body: 'eyJhIjoxfQ'.repeat(150_000) };

    expect(await optimizeField(dense, compress, CTX, MAX, FIELD_OPTIMIZE_TIMEOUT_MS, 1_000_000)).toBe(dense);
    expect(calls).toBe(0);

    const out = await optimizeField({ body: prose(1_500_000) }, compress, CTX, MAX, FIELD_OPTIMIZE_TIMEOUT_MS, 1_000_000);
    expect(calls).toBe(1);
    expect(String(out)).toContain('condensed');
  });

  it('passes the observer window through optimizeObservationFields', async () => {
    let calls = 0;
    const compress: FieldCompressor = async () => { calls++; return 'condensed'; };
    const fields = { toolInput: { small: 1 }, toolOutput: huge };

    await optimizeObservationFields(fields, compress, { sessionDbId: 1 }, MAX, FIELD_OPTIMIZE_TIMEOUT_MS, 32_768);
    expect(calls).toBe(0);
    await optimizeObservationFields(fields, compress, { sessionDbId: 1 }, MAX, FIELD_OPTIMIZE_TIMEOUT_MS, 1_000_000);
    expect(calls).toBe(1);
  });

  it('defaults to the fallback window when no window is known', async () => {
    let calls = 0;
    const compress: FieldCompressor = async () => { calls++; return 'condensed'; };
    const maxTokens = condenseInputMaxTokens(FALLBACK_CONTEXT_WINDOW_TOKENS);
    const over = { body: prose(maxTokens * 4 + 4_000) };

    expect(await optimizeField(over, compress, CTX, MAX)).toBe(over);
    expect(calls).toBe(0);
    await optimizeField(huge, compress, CTX, MAX);
    expect(calls).toBe(1);
  });
});
