// Phase 2 dispatch/ingest boundary. Shapes copy the L1 live-path fixtures in
// tests/worker/observer-image-strip-live-path.test.ts; bounds come from the
// frozen media contract. No converter or network is used here.
import { describe, expect, it } from 'bun:test';
import { MEDIA_LIMITS } from '../../src/shared/media-contract.js';
import { LOCAL_EVENT_MAX_BYTES, boundObservationDispatch, scanMediaFields } from '../../src/shared/media-ingress.js';
import { summarizeRequestBody } from '../../src/services/worker/http/middleware.js';

const PNG_HEAD = 'iVBORw0KGgo';
const b64 = (chars: number) => PNG_HEAD + 'A'.repeat(chars - PNG_HEAD.length - 1) + '=';
const SMALL = b64(4000);

const SHAPES = {
  anthropic_base64: { content: [{ type: 'text', text: 'viewport 1280x720' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SMALL } }] },
  claude_read_base64: { type: 'image', file: { base64: SMALL, media_type: 'image/png' } },
  mcp_base64: { content: [{ type: 'text', text: 'Browser tab: 1' }, { type: 'image', data: SMALL, mimeType: 'image/png' }] },
  openai_data_url: { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + SMALL } }] },
} as const;

describe('recognized native shapes', () => {
  for (const [shape, response] of Object.entries(SHAPES)) {
    it(`${shape} becomes a typed capture candidate and leaves no bytes in the text`, () => {
      const scanned = scanMediaFields({ action: 'screenshot' }, response, 'capture');
      expect(scanned.candidates).toHaveLength(1);
      expect(scanned.candidates[0]).toMatchObject({ shape, label: 'event1_image1', mimeType: 'image/png', encoded: SMALL });
      const text = JSON.stringify(scanned.toolResponse);
      expect(text).not.toContain(PNG_HEAD);
      expect(text).not.toContain('data:image');
      expect(text).toContain('image data withheld from the observer');
      expect(scanned.failures).toEqual([]);
    });
  }

  it('JSON-encoded tool responses (Codex MCP) are scanned and stay a string', () => {
    const response = JSON.stringify(SHAPES.mcp_base64);
    const scanned = scanMediaFields({}, response, 'capture');
    expect(scanned.candidates).toHaveLength(1);
    expect(typeof scanned.toolResponse).toBe('string');
    expect(scanned.toolResponse as string).toContain('Browser tab: 1');
    expect(scanned.toolResponse as string).not.toContain(PNG_HEAD);
  });

  it('a typed Read file locator is a candidate, but a bare path string never is', () => {
    const typed = scanMediaFields({ file_path: '/p/shot.png' }, { type: 'image', file: { path: '/p/shot.png' } }, 'capture');
    expect(typed.candidates).toEqual([{ shape: 'trusted_tool_file', filePath: '/p/shot.png', pointer: '/tool_response', label: 'event1_image1' }]);
    const bare = scanMediaFields({ file_path: '/p/shot.png' }, 'Saved screenshot to /p/shot.png', 'capture');
    expect(bare.candidates).toEqual([]);
    const url = scanMediaFields({}, { type: 'image', source: { type: 'url', url: 'https://example.test/x.png' } }, 'capture');
    expect(url.candidates).toEqual([]);
  });

  it('unsupported formats and loose data URLs are elided with honest failure state', () => {
    const svg = scanMediaFields({}, { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: SMALL } }, 'capture');
    expect(svg.candidates).toEqual([]);
    expect(svg.failures[0]).toMatchObject({ state: 'rejected', code: 'unsupported_format', inspection: 'uninspected' });
    const loose = scanMediaFields({}, { meta: { screenshot: 'data:image/jpeg;base64,' + SMALL } }, 'capture');
    expect(JSON.stringify(loose.toolResponse)).not.toContain(PNG_HEAD);
    expect(loose.failures[0]).toMatchObject({ code: 'unsupported_source' });
  });

  it('disabled capture leaves bounded text and disabled state, never bytes', () => {
    const scanned = scanMediaFields({}, SHAPES.anthropic_base64, 'disabled');
    expect(scanned.candidates).toEqual([]);
    expect(scanned.failures).toEqual([{ version: 1, state: 'disabled', code: 'converter_disabled', inspection: 'uninspected', label: 'event1_image1' }]);
    const text = JSON.stringify(scanned.toolResponse);
    expect(text).not.toContain(PNG_HEAD);
    expect(text).toContain('viewport 1280x720');
  });

  it('more than four images in one event rejects the excess', () => {
    const content = Array.from({ length: 6 }, () => ({ type: 'image', data: SMALL, mimeType: 'image/png' }));
    const scanned = scanMediaFields({}, { content }, 'capture');
    expect(scanned.candidates.map(c => c.label)).toEqual(['event1_image1', 'event1_image2', 'event1_image3', 'event1_image4']);
    expect(scanned.failures.map(f => f.code)).toEqual(['source_too_large', 'source_too_large']);
  });

  it('an image-free payload keeps its identity and encoding', () => {
    const input = { command: 'git status' };
    const response = { stdout: 'clean' };
    const scanned = scanMediaFields(input, response, 'capture');
    expect(scanned.toolInput).toBe(input);
    expect(scanned.toolResponse).toBe(response);
  });
});

describe('pre-dispatch inline bounds', () => {
  it('keeps accepted bytes for small events so the worker can convert them', () => {
    const body = { tool_name: 'x', tool_input: {}, tool_response: SHAPES.anthropic_base64 };
    const bounded = boundObservationDispatch(body);
    expect(JSON.stringify(bounded.tool_response)).toContain(SMALL);
  });

  it('sanitizes multi-image base64 above the aggregate inline bound before HTTP, keeping text and the 5mb cap', () => {
    const big = b64(1_500_000);
    const content = [
      { type: 'text', text: 'USEFUL CAPTION before images' },
      ...Array.from({ length: 5 }, () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } })),
      { type: 'text', text: 'USEFUL CAPTION after images' },
    ];
    const body = { contentSessionId: 's', tool_name: 'mcp__browser__screenshot', tool_input: { action: 'shots' }, tool_response: { content } };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(LOCAL_EVENT_MAX_BYTES);
    const bounded = boundObservationDispatch(body);
    const wire = JSON.stringify(bounded);
    expect(Buffer.byteLength(wire)).toBeLessThan(LOCAL_EVENT_MAX_BYTES);
    expect(wire).toContain('USEFUL CAPTION before images');
    expect(wire).toContain('USEFUL CAPTION after images');
    // Two 1.5M bodies fit the 4 MiB aggregate; the rest become descriptors.
    expect(wire.split(big).length - 1).toBe(2);
    expect(wire.match(/"code":"source_too_large"/g)?.length).toBe(3);
    expect(MEDIA_LIMITS.maxInlineEncodedBytes).toBe(4 * 1024 * 1024);
  });

  it('an event still oversized after image removal is clipped head/tail below the cap', () => {
    const wall = 'HEAD-MARKER ' + 'x'.repeat(6 * 1024 * 1024) + ' TAIL-MARKER';
    const body = { tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: { stdout: wall, content: [{ type: 'image', data: SMALL, mimeType: 'image/png' }] } };
    const wire = JSON.stringify(boundObservationDispatch(body));
    expect(Buffer.byteLength(wire)).toBeLessThan(LOCAL_EVENT_MAX_BYTES);
    expect(wire).toContain('HEAD-MARKER');
    expect(wire).toContain('TAIL-MARKER');
    expect(wire).not.toContain(PNG_HEAD);
  });

  it('request log summaries carry no image body', () => {
    const summary = summarizeRequestBody('POST', '/api/sessions/observations', {
      tool_name: 'Read', tool_input: { file_path: '/a.png', image: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SMALL } } },
    });
    expect(summary).not.toContain(PNG_HEAD);
  });
});

// Structure copied from a real Claude Code Read image result (bytes generated
// here, never copied): Claude Code names the MIME `file.type`, not
// `file.media_type`, and carries originalSize/dimensions beside the bytes.
const realReadImageResult = (base64: string, declaredType: string | null = 'image/png') => ({
  type: 'image',
  file: {
    base64,
    ...(declaredType === null ? {} : { type: declaredType }),
    originalSize: 90376,
    dimensions: { originalWidth: 1440, originalHeight: 900, displayWidth: 1440, displayHeight: 900 },
  },
});

describe('walk bounds never rewrite image-free payloads', () => {
  const globWithFiveThousandFilenames = {
    filenames: Array.from({ length: 5000 }, (_, index) => `/repo/src/generated/file-${index}.ts`),
    durationMs: 12, numFiles: 5000, truncated: false,
  };
  const buildNestedObject = (levels: number): unknown => {
    let nested: unknown = { leaf: 'deepest value', count: 1 };
    for (let level = 0; level < levels; level++) nested = { level, child: nested };
    return nested;
  };

  for (const [name, toolResponse] of [
    ['a Glob result with 5000 filenames', globWithFiveThousandFilenames],
    ['a 25-level nested object', buildNestedObject(25)],
    ['a 25-level nested object encoded as JSON text that mentions image_url', JSON.stringify({ note: 'image_url', nested: buildNestedObject(25) })],
  ] as const) {
    it(`${name} passes through dispatch and capture byte-identical`, () => {
      const body = { contentSessionId: 's', tool_name: 'Glob', tool_input: { pattern: '**/*.ts', nested: buildNestedObject(25) }, tool_response: toolResponse };
      expect(JSON.stringify(boundObservationDispatch(body))).toBe(JSON.stringify(body));
      for (const stage of ['dispatch', 'capture', 'disabled'] as const) {
        const scanned = scanMediaFields(body.tool_input, toolResponse, stage);
        expect(JSON.stringify(scanned.toolInput)).toBe(JSON.stringify(body.tool_input));
        expect(JSON.stringify(scanned.toolResponse)).toBe(JSON.stringify(toolResponse));
        expect(JSON.stringify(scanned)).not.toContain('invalid_manifest');
        expect(scanned.failures).toEqual([]);
      }
    });
  }

  it('reports reaching the walk limit as a flag, not as a media failure', () => {
    const scanned = scanMediaFields({}, globWithFiveThousandFilenames, 'capture');
    expect(scanned.walkLimitReached).toBe(true);
    expect(scanMediaFields({}, { stdout: 'small' }, 'capture').walkLimitReached).toBe(false);
  });

  it('an image inside the bound is still recognized when a huge list follows it', () => {
    const scanned = scanMediaFields({}, { image: SHAPES.mcp_base64, ...globWithFiveThousandFilenames }, 'capture');
    expect(scanned.candidates).toHaveLength(1);
    expect(JSON.stringify(scanned.toolResponse)).not.toContain(PNG_HEAD);
    expect(JSON.stringify(scanned.toolResponse)).toContain('file-4999.ts');
  });
});

describe('real Claude Code Read image results', () => {
  it('file.type names the MIME, so the image is a capture candidate rather than unsupported_format', () => {
    const scanned = scanMediaFields({ file_path: '/p/shot.png' }, realReadImageResult(SMALL), 'capture');
    expect(scanned.failures).toEqual([]);
    expect(scanned.candidates).toEqual([{ shape: 'claude_read_base64', encoded: SMALL, mimeType: 'image/png', pointer: '/tool_response', label: 'event1_image1' }]);
  });

  it('file.media_type is still accepted', () => {
    const scanned = scanMediaFields({}, SHAPES.claude_read_base64, 'capture');
    expect(scanned.candidates[0]).toMatchObject({ shape: 'claude_read_base64', mimeType: 'image/png' });
  });

  it('a Read image with no declared MIME is left to the worker magic-byte check', () => {
    const scanned = scanMediaFields({}, realReadImageResult(SMALL, null), 'capture');
    expect(scanned.failures).toEqual([]);
    expect(scanned.candidates[0]).toMatchObject({ shape: 'claude_read_base64', encoded: SMALL });
    expect(scanned.candidates[0].mimeType).toBeUndefined();
  });

  it('a declared unsupported Read MIME is still rejected early', () => {
    const scanned = scanMediaFields({}, realReadImageResult(SMALL, 'image/gif'), 'capture');
    expect(scanned.candidates).toEqual([]);
    expect(scanned.failures[0]).toMatchObject({ code: 'unsupported_format' });
  });

  it('dispatch keeps the real Read bytes so the worker can convert them', () => {
    const body = { tool_name: 'Read', tool_input: { file_path: '/p/shot.png' }, tool_response: realReadImageResult(SMALL) };
    expect(JSON.stringify(boundObservationDispatch(body))).toBe(JSON.stringify(body));
  });

  it('elision replaces only the byte field and keeps originalSize, dimensions and type', () => {
    const scanned = scanMediaFields({}, realReadImageResult(SMALL), 'disabled');
    const file = (scanned.toolResponse as { file: Record<string, unknown> }).file;
    expect(file.base64).toBeUndefined();
    expect(file).toMatchObject({
      elided: 'image data withheld from the observer', bytes: SMALL.length, type: 'image/png', originalSize: 90376,
      dimensions: { originalWidth: 1440, originalHeight: 900, displayWidth: 1440, displayHeight: 900 },
    });
    expect(JSON.stringify(scanned.toolResponse)).not.toContain(PNG_HEAD);
  });
});
