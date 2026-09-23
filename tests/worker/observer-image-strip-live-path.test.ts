// The image sanitizer (#3730) is shape-based, so it only works on parsed JSON.
// On the real path it never got any: the ingest boundary stores a tool payload
// as JSON *text*, so every provider hands the stripper a string, and a string
// is returned untouched. The existing coverage builds the field itself, single
// encoded, and therefore passes while production ships the whole image.
//
// These tests go through `ingestObservation` and then build the prompt the way
// a provider does, so the encoding is the real one. Two things are pinned: the
// bytes never reach the compressor model (the expensive half — #3606 measured
// 225k-501k input tokens per condense of a video frame), and they never reach
// the prompt.
import { describe, test, expect } from 'bun:test';
import { createServer } from 'node:http';

import { buildObservationPrompt } from '../../src/sdk/prompts.js';
import { optimizeObservationFields } from '../../src/services/worker/field-optimizer.js';
import { ingestObservation, setIngestContext } from '../../src/services/worker/http/shared.js';

const BASE64 = 'iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(300_000);

/** Post one observation through the HTTP ingest route and return what was queued. */
async function ingest(toolName: string, toolInput: unknown, toolResponse: unknown) {
  let queued: any;
  setIngestContext({
    dbManager: { getSessionStore: () => ({ createSDKSession: () => 1,
      getPromptNumberFromUserPrompts: () => 1, getUserPrompt: () => 'public fixture' }) } as any,
    sessionManager: { queueObservation: async (_id: number, observation: any) => { queued = observation; } } as any,
    eventBroadcaster: { broadcastObservationQueued: () => {} } as any,
    ensureGeneratorRunning: async () => {},
  });
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    res.end(JSON.stringify(await ingestObservation(JSON.parse(body))));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/observation`, { method: 'POST',
      body: JSON.stringify({ contentSessionId: `image-strip-${toolName}`, toolName, toolInput, toolResponse, cwd: '/fixture' }) });
    expect((await response.json() as any).ok).toBe(true);
    return queued;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

/** Run a queued observation the rest of the way: condense pass, then prompt. */
async function observe(queued: any) {
  const compressed: string[] = [];
  const optimized = await optimizeObservationFields(
    { toolInput: queued.tool_input, toolOutput: queued.tool_response },
    async (text: string) => { compressed.push(text); return null; },
    { sessionDbId: 1, toolName: queued.tool_name },
  );
  const prompt = buildObservationPrompt({
    id: 0,
    tool_name: queued.tool_name,
    tool_input: JSON.stringify(optimized.toolInput),
    tool_output: JSON.stringify(optimized.toolOutput),
    created_at_epoch: Date.now(),
    cwd: queued.cwd,
  });
  return { prompt, compressed };
}

describe('observer image stripping on the real ingest path (#3606)', () => {
  test('a Read of an image file sends no base64 to the compressor or the prompt', async () => {
    // Claude Code returns an image file in this shape: `file.base64`, not
    // `source.data`, so the Anthropic branch of the stripper never matched it.
    const queued = await ingest('Read', { file_path: '/frames/0001.png' },
      { type: 'image', file: { base64: BASE64, media_type: 'image/png' } });
    const { prompt, compressed } = await observe(queued);

    expect(compressed).toEqual([]);
    expect(prompt).not.toContain('iVBORw0KGgo');
    expect(/A{200,}/.test(prompt)).toBe(false);
  });

  test('an Anthropic image block sends no base64 to the compressor or the prompt', async () => {
    // This shape the stripper does know. It still shipped whole, because the
    // ingest boundary had already turned the payload into a string.
    const queued = await ingest('mcp__claude-in-chrome__computer', { action: 'screenshot' },
      { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: BASE64 } }] });
    const { prompt, compressed } = await observe(queued);

    expect(compressed).toEqual([]);
    expect(prompt).not.toContain('iVBORw0KGgo');
    expect(/A{200,}/.test(prompt)).toBe(false);
  });

  test('says what it withheld, and keeps the text beside the image', async () => {
    const queued = await ingest('mcp__claude-in-chrome__computer', { action: 'screenshot' },
      { content: [
        { type: 'text', text: 'Took a screenshot of the viewport at 1280x720.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BASE64 } },
      ] });
    const { prompt } = await observe(queued);

    expect(prompt).toContain('Took a screenshot of the viewport at 1280x720.');
    expect(prompt).toContain('image data withheld from the observer');
    expect(prompt).toContain(String(BASE64.length));
    expect(prompt).toContain('image/png');
  });

  test('the observation still fits without being truncated', async () => {
    // Stripping has to be what shrinks this, not the head/tail guard: an
    // elided marker here would mean the image was still being measured.
    const queued = await ingest('Read', { file_path: '/frames/0001.png' },
      { type: 'image', file: { base64: BASE64 } });
    const { prompt } = await observe(queued);

    expect(prompt).not.toContain('reason="oversize"');
    expect(prompt.length).toBeLessThan(4_000);
  });

  test('oversized text still goes to the compressor — the condense pass is untouched', async () => {
    const wall = 'error: cannot open file\n'.repeat(12_000);
    const queued = await ingest('Bash', { command: 'make' }, { stdout: wall });
    const { compressed } = await observe(queued);

    expect(compressed.length).toBe(1);
    expect(compressed[0]).toContain('error: cannot open file');
  });

  test('a url-backed image is left alone — it is short and it carries signal', async () => {
    const queued = await ingest('Read', { file_path: '/frames/0001.png' },
      { type: 'image', source: { type: 'url', url: 'https://example.test/frame.png' } });
    const { prompt } = await observe(queued);

    expect(prompt).toContain('https://example.test/frame.png');
    expect(prompt).not.toContain('image data withheld from the observer');
  });

  test('a provider that runs no condense pass still strips', async () => {
    // ClaudeProvider skips optimizeObservationFields when it has no field
    // compressor, and hands the queued payload straight to the prompt. That
    // is the double-encoded string, so the prompt build has to be able to
    // strip it on its own.
    const queued = await ingest('Read', { file_path: '/frames/0001.png' },
      { type: 'image', file: { base64: BASE64 } });
    const prompt = buildObservationPrompt({
      id: 0,
      tool_name: queued.tool_name,
      tool_input: JSON.stringify(queued.tool_input),
      tool_output: JSON.stringify(queued.tool_response),
      created_at_epoch: Date.now(),
      cwd: queued.cwd,
    });

    expect(prompt).not.toContain('iVBORw0KGgo');
    expect(/A{200,}/.test(prompt)).toBe(false);
    expect(prompt).toContain('image data withheld from the observer');
  });

  test('a payload with no image keeps the encoding it arrived with', async () => {
    // Stripping must not quietly re-encode every observation in the product
    // on its way past: only a field that actually had an image in it changes.
    const queued = await ingest('Bash', { command: 'git status' }, { stdout: 'nothing to commit' });
    const optimized = await optimizeObservationFields(
      { toolInput: queued.tool_input, toolOutput: queued.tool_response },
      async () => null, { sessionDbId: 1, toolName: queued.tool_name },
    );

    expect(optimized.toolInput).toBe(queued.tool_input);
    expect(optimized.toolOutput).toBe(queued.tool_response);
  });

  test('an image block with no inlined bytes is left alone', async () => {
    const queued = await ingest('Read', { file_path: '/frames/0001.png' },
      { type: 'image', file: { path: '/frames/0001.png' } });
    const { prompt } = await observe(queued);

    expect(prompt).toContain('/frames/0001.png');
    expect(prompt).not.toContain('image data withheld from the observer');
  });
});
