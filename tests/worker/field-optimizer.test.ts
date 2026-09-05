import { describe, it, expect } from 'bun:test';
import {
  optimizeField,
  optimizeObservationFields,
  buildFieldCompressionPrompt,
  FieldInputBudgetError,
  FieldCompressionError,
  FIELD_OPTIMIZE_DEFAULT_MAX_INPUT_BYTES,
  type FieldCompressor,
} from '../../src/services/worker/field-optimizer.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';

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

  it('propagates model failures to the owner instead of swallowing policy decisions', async () => {
    const error = new Error('gateway down');
    const compress: FieldCompressor = async () => { throw error; };
    await expect(optimizeField(oversized, compress, CTX, MAX)).rejects.toBe(error);
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

describe('oversized-field safety (#3839)', () => {
  const binary = Buffer.alloc(2_000_000, 0xff);
  const encoded = binary.toString('base64');
  const unexpected: FieldCompressor = async () => { throw new Error('unexpected model call'); };

  it('normalizes huge nested image data URLs, preserving sibling metadata and mixed text', async () => {
    const value = {
      path: '/tmp/screen.png', width: 1920, height: 1080,
      content: [
        { type: 'text', text: 'Build failed: EACCES /src/main.ts:42' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${encoded}` } },
      ],
      notes: `before screenshot data:image/png;base64,${encoded} after: exit 7`,
    };
    const out = await optimizeField(value, unexpected, CTX) as typeof value;
    expect(out.path).toBe(value.path);
    expect(out.width).toBe(1920);
    expect(out.height).toBe(1080);
    expect(out.content[0]).toEqual(value.content[0]);
    expect(out.notes).toContain('before screenshot');
    expect(out.notes).toContain('after: exit 7');
    expect(out.notes).toContain('binary omitted: data:image/png;base64');
    expect(JSON.stringify(out)).toContain(`encoded_chars=${encoded.length}`);
    expect(JSON.stringify(out).length).toBeLessThan(2000);
    expect(value.notes).toContain(encoded);
  });

  it('normalizes Buffers, ArrayBuffers and typed views without dropping metadata', async () => {
    const value = { path: '/tmp/frame', buffer: binary, array: binary.buffer,
      view: new DataView(binary.buffer, 2, 100), typed: new Uint8Array(800_000),
      status: 'captured', bytes: binary.byteLength };
    const out = await optimizeField(value, unexpected, CTX) as Record<string, unknown>;
    expect(out.buffer).toBe('[binary omitted: Buffer; bytes=2000000]');
    expect(out.view).toBe('[binary omitted: DataView; bytes=100]');
    expect(out.typed).toBe('[binary omitted: Uint8Array; bytes=800000]');
    expect(out.status).toBe('captured');
    expect(out.bytes).toBe(2_000_000);
    expect(JSON.stringify(out).length).toBeLessThan(600);
  });

  it('handles serialized buffers and provider-neutral base64 envelopes', async () => {
    const value = {
      buffer: { type: 'Buffer', data: Array(200_000).fill(255), path: '/img' },
      source: { type: 'base64', media_type: 'image/png', data: encoded },
      image: { type: 'image', mimeType: 'image/jpeg', encoding: 'base64', data: encoded },
      base64: encoded, b64_json: encoded,
    };
    const out = await optimizeField(value, unexpected, CTX) as typeof value;
    expect(out.buffer.path).toBe('/img');
    expect(String(out.buffer.data)).toContain('bytes=200000');
    expect(out.source.media_type).toBe('image/png');
    expect(out.source.data).toContain('binary omitted');
    expect(out.image.data).toContain('binary omitted');
    expect(out.base64).toContain('binary omitted');
    expect(out.b64_json).toContain('binary omitted');
  });

  it('recognizes a bare base64 PNG without guessing arbitrary alphabetic strings', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), binary]).toString('base64');
    const out = await optimizeField(png, unexpected, CTX);
    expect(String(out)).toContain('binary omitted');
    let calls = 0;
    const text = await optimizeField('important'.repeat(100_000), async part => {
      calls++;
      expect(part).not.toContain('binary omitted');
      return 'important text';
    }, CTX);
    expect(String(text)).toContain('important text');
    expect(calls).toBeGreaterThan(1);
  });

  it('normalizes serialized JSON tool output while retaining its string type and metadata', async () => {
    const value = JSON.stringify({ name: '/screenshot.png', status: 'ok',
      buffer: { type: 'Buffer', data: Array(100_000).fill(255) },
      source: { type: 'base64', media_type: 'image/png', data: encoded },
      text: 'Decision recorded in /notes.md; exit 0' });
    const out = await optimizeField(value, unexpected, CTX);
    expect(typeof out).toBe('string');
    const parsed = JSON.parse(out as string);
    expect(parsed.name).toBe('/screenshot.png');
    expect(parsed.status).toBe('ok');
    expect(parsed.text).toBe('Decision recorded in /notes.md; exit 0');
    expect(parsed.source.data).toContain('binary omitted');
    expect(parsed.buffer.data).toContain('bytes=100000');
    expect((out as string).length).toBeLessThan(600);
  });

  it('retains encoded substantive UTF-8 text', async () => {
    const text = 'Error: /src/critical.ts:12 status=503\n'.repeat(60);
    const out = await optimizeField({ base64: Buffer.from(text).toString('base64') }, unexpected, CTX);
    expect(JSON.stringify(out)).toContain('Error: /src/critical.ts:12 status=503');
    expect(JSON.stringify(out)).toContain('[decoded base64');
    expect(JSON.stringify(out)).not.toContain('binary omitted');
    const large = await optimizeField(`data:text/plain;base64,${Buffer.from(text.repeat(100)).toString('base64')}`,
      async part => {
        expect(part).not.toContain('binary omitted');
        return 'Error: /src/critical.ts:12 status=503';
      }, CTX);
    expect(String(large)).toContain('Error: /src/critical.ts:12 status=503');
  });

  it('preserves printable text buffers and condenses huge logs instead of discarding them', async () => {
    const text = 'Error: migration failed for /db/schema.sql; status=503\n';
    const out = await optimizeField(Buffer.from(text), unexpected, CTX);
    expect(String(out)).toContain(text);
    expect(String(out)).toContain('[decoded Buffer; bytes=');
    const serialized = await optimizeField(Buffer.from(text).toJSON(), unexpected, CTX);
    expect((serialized as { data: string }).data).toContain(text);
    const large = await optimizeField(Buffer.from(text.repeat(20_000)), async part => {
      expect(part).not.toContain('binary omitted');
      return 'Migration failed for /db/schema.sql; status=503';
    }, CTX);
    expect(String(large)).toContain('Migration failed for /db/schema.sql; status=503');
  });

  it('does not infer base64 encoding from MIME metadata or a content type', async () => {
    const data = 'Build succeeded tests passed exit 0 '.repeat(40);
    for (const metadata of [{ mimeType: 'text/plain' }, { media_type: 'text/plain' },
      { mimeType: 'image/png' }, { media_type: 'image/png' }, { type: 'image' }, { type: 'audio' }]) {
      const value = { ...metadata, data };
      expect(await optimizeField(value, unexpected, CTX)).toBe(value);
    }
  });

  it('compresses oversized MIME-tagged plain text without discarding it as binary', async () => {
    const value = { mimeType: 'text/plain', data: 'Build succeeded tests passed exit 0 '.repeat(1800) };
    let calls = 0;
    const out = await optimizeField(value, async text => {
      calls++;
      expect(text).toContain('Build succeeded tests passed exit 0');
      expect(text).not.toContain('binary omitted');
      return 'Build succeeded tests passed exit 0';
    }, CTX);
    expect(calls).toBeGreaterThan(1);
    expect(String(out)).toContain('Build succeeded tests passed exit 0');
    expect(String(out)).not.toContain('binary omitted');
  });

  it('preserves ANSI-colored UTF-8 logs in buffers and serialized byte arrays', async () => {
    const text = '\x1b[31mERROR payment write failed exit 7\x1b[0m\r\n';
    for (const bytes of [Buffer.from(text), new Uint8Array(Buffer.from(text)), Buffer.from(text).toJSON()]) {
      const out = await optimizeField(bytes, unexpected, CTX);
      const decoded = typeof out === 'string' ? out : (out as { data: string }).data;
      expect(decoded).toContain(text);
      expect(decoded).toContain('ERROR payment write failed exit 7');
      expect(decoded).not.toContain('binary omitted');
    }
  });

  it('preserves ANSI log text and OSC metadata in data URLs and explicit base64 envelopes', async () => {
    const text = ('\x1b[31mERROR payment write failed exit 7\x1b[0m ' +
      '\x1b]8;;https://example.invalid/receipt\x07receipt\x1b]8;;\x07\n').repeat(20);
    const data = Buffer.from(text).toString('base64');
    for (const value of [`data:text/plain;base64,${data}`, { encoding: 'base64', data }]) {
      const out = await optimizeField(value, unexpected, CTX);
      const decoded = typeof out === 'string' ? out : (out as { data: string }).data;
      expect(decoded).toContain(text);
      expect(decoded).toContain('ERROR payment write failed exit 7');
      expect(decoded).toContain('https://example.invalid/receipt');
      expect(decoded).not.toContain('binary omitted');
    }
  });

  it('preserves the short OSC window-title log reproduced under Bun', async () => {
    const text = '\x1b]0;build failed\x07ERROR exit 7\n';
    const out = await optimizeField(Buffer.from(text), unexpected, CTX);
    expect(out).toContain('[decoded Buffer; bytes=30]');
    expect(out).toContain(text);
    expect(out).not.toContain('binary omitted');
  });

  for (const [terminator, ending] of [['BEL', '\x07'], ['ST', '\x1b\\'], ['C1 ST', '\u009c']]) {
    it(`preserves complete OSC window titles with ${terminator} across byte/encoding carriers`, async () => {
      const text = `\x1b]0;build failed${ending}ERROR exit 7\n`.repeat(40);
      const buffer = Buffer.from(text);
      const base64 = buffer.toString('base64');
      const identity = (out: unknown) => out as string;
      const data = (out: unknown) => (out as { data: string }).data;
      const carriers: Array<{ value: unknown; read: (out: unknown) => string }> = [
        { value: buffer, read: identity },
        { value: new Uint8Array(buffer), read: identity },
        { value: new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength), read: identity },
        { value: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), read: identity },
        { value: buffer.toJSON(), read: data },
        { value: JSON.stringify(buffer.toJSON()), read: out => data(JSON.parse(out as string)) },
        { value: `data:text/plain;base64,${base64}`, read: identity },
        { value: { encoding: 'base64', data: base64 }, read: data },
        { value: { type: 'base64', media_type: 'text/plain', data: base64 }, read: data },
        { value: { base64 }, read: out => (out as { base64: string }).base64 },
      ];
      for (const carrier of carriers) {
        const decoded = carrier.read(await optimizeField(carrier.value, unexpected, CTX));
        expect(decoded).toContain(text);
        expect(decoded).toContain('build failed');
        expect(decoded).toContain('ERROR exit 7');
        expect(decoded).not.toContain('binary omitted');
      }
    });
  }

  it('handles consecutive complete OSC titles without hiding unrelated binary controls', async () => {
    const text = 'before\x1b]0;build failed\x07ERROR exit 7\n\x1b]2;tests failed\x1b\\after';
    expect(await optimizeField(Buffer.from(text), unexpected, CTX)).toContain(text);
    const binary = Buffer.from(text + '\x00');
    expect(await optimizeField(binary, unexpected, CTX)).toBe(`[binary omitted: Buffer; bytes=${binary.length}]`);
  });

  it('does not permissively decode malformed base64 and discard its contents', async () => {
    const data = 'AAAA'.repeat(400) + '=broken';
    for (const value of [{ encoding: 'base64', data }, `data:text/plain;base64,${data}`]) {
      expect(await optimizeField(value, unexpected, CTX)).toBe(value);
    }
  });

  it('sends complete meaningful text and structure, never the huge binary, to the model', async () => {
    const value = { before: 'begin', image: `data:image/png;base64,${encoded}`,
      text: 'Important line with path /a.ts and status 503.\n'.repeat(400), after: 'end' };
    let calls = 0;
    const compress: FieldCompressor = async (text, budget, { signal }) => {
      calls++;
      expect(text).not.toContain(encoded);
      expect(JSON.parse(text).text).toBe(value.text);
      expect(JSON.parse(text).after).toBe('end');
      expect(text).toContain('binary omitted');
      expect(signal.aborted).toBe(false);
      expect(Buffer.byteLength(buildFieldCompressionPrompt(text, budget))).toBeLessThanOrEqual(
        FIELD_OPTIMIZE_DEFAULT_MAX_INPUT_BYTES);
      return 'Important line /a.ts status 503. Image omitted; begin to end.';
    };
    expect(String(await optimizeField(value, compress, CTX))).toContain('<condensed');
    expect(calls).toBe(1);
  });

  it('processes ordinary 50KB text completely and preserves meaningful middle content', async () => {
    const value = { text: 'BEGIN ' + 'source '.repeat(4000) + 'MIDDLE_DECISION ' +
      'source '.repeat(4000) + 'END' };
    const raw = JSON.stringify(value, null, 2);
    const parts: string[] = [];
    const out = await optimizeField(value, async (text, budget) => {
      parts.push(text);
      expect(Buffer.byteLength(buildFieldCompressionPrompt(text, budget))).toBeLessThanOrEqual(
        FIELD_OPTIMIZE_DEFAULT_MAX_INPUT_BYTES);
      return ['BEGIN', 'MIDDLE_DECISION', 'END'].filter(id => text.includes(id)).join(' ') || 'source';
    }, CTX);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(raw);
    expect(String(out)).toContain('MIDDLE_DECISION');
    expect(String(out)).toContain('BEGIN');
    expect(String(out)).toContain('END');
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(16_000);
    expect(value.text).toContain('MIDDLE_DECISION');
  });

  it('rejects only an impossible per-request framing budget, not a large field', async () => {
    await expect(optimizeField('a'.repeat(50_000), unexpected, CTX, MAX, { maxInputBytes: 100 }))
      .rejects.toBeInstanceOf(FieldInputBudgetError);
  });

  it('can raise the default input budget from provider options', async () => {
    const value = { text: 'source '.repeat(8000) };
    for (const options of [{ maxInputBytes: 64_000 }, { maxInputChars: 64_000 },
      { maxInputBytes: 64_000, maxInputChars: 1 }]) {
      let calls = 0;
      const out = await optimizeField(value, async (text, budget) => {
        calls++;
        expect(text).toBe(JSON.stringify(value, null, 2));
        const bytes = Buffer.byteLength(buildFieldCompressionPrompt(text, budget));
        expect(bytes).toBeGreaterThan(FIELD_OPTIMIZE_DEFAULT_MAX_INPUT_BYTES);
        expect(bytes).toBeLessThanOrEqual(64_000);
        return 'source summary';
      }, CTX, undefined, options);
      expect(calls).toBe(1);
      expect(String(out)).toContain('source summary');
    }
  });

  it('enforces byte budgets and partitions UTF-8 without losing or splitting code points', async () => {
    const value = '\u{1f600}\u4e00'.repeat(6000);
    const parts: string[] = [];
    const out = await optimizeField(value, async (text, budget) => {
      parts.push(text);
      expect(Buffer.byteLength(buildFieldCompressionPrompt(text, budget))).toBeLessThanOrEqual(10_000);
      expect(/[\ud800-\udbff]$/.test(text)).toBe(false);
      expect(/^[\udc00-\udfff]/.test(text)).toBe(false);
      expect(text).not.toContain('\ufffd');
      return 'unicode';
    }, CTX, MAX, { maxInputBytes: 10_000 });
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.join('')).toBe(JSON.stringify(value));
    expect(String(out)).toContain('unicode');
  });

  it('prefers line boundaries and carries a short final fragment verbatim', async () => {
    const maxBytes = 4000;
    const capacity = maxBytes - Buffer.byteLength(buildFieldCompressionPrompt('', 400));
    const value = 'x'.repeat(capacity * 2 - 1) + ' TAIL_IMPORTANT';
    let calls = 0;
    const out = await optimizeField(value, async () => { calls++; return 'body summary'; },
      CTX, 500, { maxInputBytes: maxBytes });
    expect(calls).toBe(2);
    expect(String(out)).toContain('TAIL_IMPORTANT');

    const structured = Array.from({ length: 500 }, (_, i) => ({ id: i, text: 'a complete source record' }));
    const parts: string[] = [];
    await optimizeField(structured, async text => { parts.push(text); return 'records'; },
      CTX, 1000, { maxInputBytes: maxBytes });
    for (const part of parts.slice(0, -1)) expect(part.endsWith('\n')).toBe(true);
  });

  it('reduces large text through multiple stages with bounded linear request work', async () => {
    const value = 'original source record with concrete details\n'.repeat(15_000);
    const requests: string[] = [];
    const out = await optimizeField(value, async (text, budget) => {
      requests.push(text);
      expect(Buffer.byteLength(buildFieldCompressionPrompt(text, budget))).toBeLessThanOrEqual(4000);
      return 'summary ' + 's'.repeat(budget - 8);
    }, CTX, 500, { maxInputBytes: 4000 });
    expect(requests.length).toBeGreaterThan(50);
    expect(requests.length).toBeLessThan(4 * Math.ceil(Buffer.byteLength(value) / 3000));
    expect(requests.some(text => text.startsWith('summary '))).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(500);
    expect(String(out)).toContain('<condensed');
  });

  it('processes a subsequent observation after an ordinary large field succeeds', async () => {
    const outputs: unknown[] = [];
    for (const value of [{ source: 'code '.repeat(12_000) }, { following: 'still processes' }]) {
      const result = await optimizeObservationFields({ toolInput: {}, toolOutput: value },
        async () => 'source summary', { sessionDbId: 1 });
      outputs.push(result.toolOutput);
    }
    expect(String(outputs[0])).toContain('<condensed');
    expect(outputs[1]).toEqual({ following: 'still processes' });
  });

  it('honors an explicit whole-field request budget without returning partial results', async () => {
    let calls = 0;
    await expect(optimizeField('source '.repeat(10_000), async () => {
      calls++;
      return 'partial summary';
    }, CTX, undefined, { maxRequests: 1 })).rejects.toBeInstanceOf(FieldCompressionError);
    expect(calls).toBe(1);
  });

  it('rejects unusable/nonshrinking chunk replies without truncating or retrying', async () => {
    for (const result of [null, '', 'too long '.repeat(10_000)]) {
      let calls = 0;
      await expect(optimizeField('source '.repeat(10_000), async () => {
        calls++;
        return result;
      }, CTX)).rejects.toBeInstanceOf(FieldCompressionError);
      expect(calls).toBe(1);
    }
  });

  it('propagates quota mid-pipeline unchanged and starts no later chunk or field', async () => {
    const error = new ClassifiedProviderError('quota denied', { kind: 'quota_exhausted', cause: null });
    let calls = 0;
    await expect(optimizeObservationFields({ toolInput: 'source '.repeat(15_000), toolOutput: oversized },
      async () => {
        if (++calls === 2) throw error;
        return 'partial summary';
      }, { sessionDbId: 1 })).rejects.toBe(error);
    expect(calls).toBe(2);
  });

  it('cancels a later active chunk on deadline and never starts remaining chunks', async () => {
    let calls = 0, active = 0;
    const signals: AbortSignal[] = [];
    await expect(optimizeField('source '.repeat(15_000), (_text, _budget, { signal }) => {
      signals.push(signal);
      if (++calls === 1) return Promise.resolve('partial summary');
      active++;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { active--; reject(signal.reason); }, { once: true });
      });
    }, CTX, undefined, { timeoutMs: 15 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(calls).toBe(2);
    expect(active).toBe(0);
    expect(signals[0].aborted).toBe(false);
    expect(signals[1].aborted).toBe(true);
  });

  it('stops the complete pipeline when the parent aborts between chunks', async () => {
    const controller = new AbortController();
    const reason = new Error('session stopped between chunks');
    let calls = 0;
    await expect(optimizeField('source '.repeat(15_000), async () => {
      calls++;
      controller.abort(reason);
      return 'partial summary';
    }, CTX, undefined, { signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toBe(1);
  });

  it('counts JSON escaping and summary framing against the output budget', async () => {
    const out = await optimizeField(oversized, async () => 'valid summary', CTX, MAX);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX);
    expect(await optimizeField(oversized, async () => '"\\'.repeat(45), CTX, MAX)).toBe(oversized);
    expect(await optimizeField(oversized, async () => 'x'.repeat(MAX - 10), CTX, MAX)).toBe(oversized);
  });

  it('never restores binary when the compressor declines or returns oversized output', async () => {
    const value = { image: `data:image/png;base64,${encoded}`, text: 'words '.repeat(100) };
    for (const result of [null, '', 'long'.repeat(MAX)]) {
      const out = await optimizeField(value, async () => result, CTX, MAX);
      expect(JSON.stringify(out)).not.toContain(encoded);
      expect(JSON.stringify(out)).toContain('binary omitted');
      expect((out as typeof value).text).toBe(value.text);
    }
  });

  it('aborts active transport work on timeout before rejecting', async () => {
    let active = 0;
    let seen: AbortSignal | undefined;
    const compress: FieldCompressor = (_text, _budget, { signal }) => new Promise((_resolve, reject) => {
      active++;
      seen = signal;
      signal.addEventListener('abort', () => { active--; reject(signal.reason); }, { once: true });
    });
    await expect(optimizeField(oversized, compress, CTX, MAX, { timeoutMs: 15 }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(seen?.aborted).toBe(true);
    expect(active).toBe(0);
  });

  it('bounds waiting even for legacy callbacks that ignore cancellation', async () => {
    await expect(optimizeField(oversized, async () => new Promise(() => {}), CTX, MAX,
      { timeoutMs: 15 })).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('forwards outer abort and its exact reason to active transport', async () => {
    const outer = new AbortController();
    const reason = new Error('session stopped');
    let active = 0;
    let seen: AbortSignal | undefined;
    const compress: FieldCompressor = (_text, _budget, { signal }) => new Promise((_resolve, reject) => {
      active++;
      seen = signal;
      signal.addEventListener('abort', () => { active--; reject(signal.reason); }, { once: true });
      outer.abort(reason);
    });
    await expect(optimizeField(oversized, compress, CTX, MAX, { signal: outer.signal }))
      .rejects.toBe(reason);
    expect(seen?.reason).toBe(reason);
    expect(active).toBe(0);
  });

  it('never calls a model for a pre-aborted operation, even when the field fits', async () => {
    const controller = new AbortController();
    controller.abort();
    for (const value of [oversized, { small: true }]) {
      await expect(optimizeField(value, unexpected, CTX, MAX, { signal: controller.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
    }
  });

  it('cleans up the outer abort listener after success and callback failure', async () => {
    const controller = new AbortController();
    let added = 0, removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args: Parameters<typeof add>) => { added++; add(...args); };
    controller.signal.removeEventListener = (...args: Parameters<typeof remove>) => { removed++; remove(...args); };
    await optimizeField(oversized, async () => 'summary', CTX, MAX, { signal: controller.signal });
    const failure = new Error('sync failure');
    await expect(optimizeField(oversized, () => { throw failure; }, CTX, MAX,
      { signal: controller.signal })).rejects.toBe(failure);
    expect(added).toBe(2);
    expect(removed).toBe(2);
  });

  for (const kind of ['quota_exhausted', 'auth_invalid', 'rate_limit', 'setup_required']) {
    it(`propagates ${kind} unchanged and does not launch a second field request`, async () => {
      const error = new ClassifiedProviderError('provider denied', { kind, cause: null, retryAfterMs: 1000 });
      let calls = 0;
      const compress: FieldCompressor = async () => { calls++; throw error; };
      await expect(optimizeObservationFields({ toolInput: oversized, toolOutput: oversized },
        compress, { sessionDbId: 1 }, MAX)).rejects.toBe(error);
      expect(calls).toBe(1);
    });
  }

  it('passes cancellation options to both fields without late cancellation after success', async () => {
    const signals: AbortSignal[] = [];
    const outer = new AbortController();
    await optimizeObservationFields({ toolInput: oversized, toolOutput: oversized },
      async (_text, _budget, { signal }) => { signals.push(signal); return 'ok'; },
      { sessionDbId: 1 }, MAX, { signal: outer.signal });
    expect(signals.length).toBe(2);
    outer.abort();
    expect(signals.every(s => !s.aborted)).toBe(true);
  });

  it('keeps ordinary object identity and JSON serialization semantics', async () => {
    for (const value of [undefined, null, true, 3, 'hello', ['a', 'b'],
      { data: 'plain data', encoding: 'utf8' }, new Date('2026-09-05T00:00:00Z')]) {
      expect(await optimizeField(value, unexpected, CTX)).toBe(value);
    }
  });

  it('rejects invalid controls before calling the model', async () => {
    for (const timeoutMs of [0, -1, NaN, Infinity, 2 ** 32]) {
      await expect(optimizeField(oversized, unexpected, CTX, MAX, { timeoutMs }))
        .rejects.toBeInstanceOf(RangeError);
    }
    await expect(optimizeField(oversized, unexpected, CTX, MAX, { maxInputChars: NaN }))
      .rejects.toBeInstanceOf(RangeError);
    await expect(optimizeField(oversized, unexpected, CTX, MAX, { maxInputBytes: NaN }))
      .rejects.toBeInstanceOf(RangeError);
    await expect(optimizeField(oversized, unexpected, CTX, MAX, { maxRequests: 0 }))
      .rejects.toBeInstanceOf(RangeError);
  });
});
