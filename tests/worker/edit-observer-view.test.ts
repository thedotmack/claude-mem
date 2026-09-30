import { test, expect } from 'bun:test';
import { optimizeObservationFields } from '../../src/services/worker/field-optimizer.js';
import { ingestObservation, setIngestContext } from '../../src/services/worker/http/shared.js';
import { createServer } from 'node:http';

const input = { file_path: '/fixture/huge.ts', old_string: 'old()', new_string: 'new()', replace_all: false };
const prefix = 'x'.repeat(100_000);
const output = { filePath: input.file_path, oldString: input.old_string, newString: input.new_string,
  originalFile: null, userModified: false,
  structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
    lines: ['-' + prefix + 'old()', '+' + prefix + 'new()'] }] };

test('HTTP ingestion preserves raw strings while the native observer view shrinks', async () => {
  let queued: any;
  let optimized: any;
  let calls = 0;
  setIngestContext({
    dbManager: { getSessionStore: () => ({ createSDKSession: () => 1,
      getPromptNumberFromUserPrompts: () => 1, getUserPrompt: () => 'public fixture' }) } as any,
    sessionManager: { queueObservation: async (_id: number, observation: any) => { queued = observation; } } as any,
    eventBroadcaster: { broadcastObservationQueued: () => {} } as any,
    ensureGeneratorRunning: async () => {
      optimized = await optimizeObservationFields({ toolInput: queued.tool_input, toolOutput: queued.tool_response },
        async () => { calls++; return null; }, { sessionDbId: 1, toolName: queued.tool_name });
    },
  });
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    res.end(JSON.stringify(await ingestObservation(JSON.parse(body))));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const result = await fetch(`http://127.0.0.1:${port}/observation`, { method: 'POST',
      body: JSON.stringify({ contentSessionId: 'isolated-edit-test', toolName: 'Edit', toolInput: input, toolResponse: output, cwd: '/fixture' }) });
    expect((await result.json() as any).ok).toBe(true);
    expect(JSON.parse(queued.tool_response)).toEqual(output);
    expect(JSON.parse(queued.tool_input)).toEqual(input);
    expect(calls).toBe(0);
    expect(JSON.stringify(optimized.toolOutput).length).toBeLessThan(2000);
    console.log('EDIT_VIEW_BYTES', queued.tool_response.length, JSON.stringify(optimized.toolOutput).length);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('native Edit observer view removes redundant patch bytes for objects and HTTP JSON strings', async () => {
  for (const encoded of [false, true]) {
    const fields = { toolInput: encoded ? JSON.stringify(input) : input, toolOutput: encoded ? JSON.stringify(output) : output };
    const before = JSON.stringify(fields);
    let calls = 0;
    const optimized = await optimizeObservationFields(fields, async () => { calls++; return null; }, { sessionDbId: 0, toolName: 'Edit' });
    expect(calls).toBe(0);
    expect(JSON.stringify(optimized.toolOutput).length).toBeLessThan(2000);
    expect(optimized.toolOutput).toMatchObject({ filePath: input.file_path, oldString: 'old()', newString: 'new()', userModified: false });
    expect(JSON.stringify(optimized.toolOutput)).toContain('omitted');
    expect(JSON.stringify(fields)).toBe(before);
  }
});

test('Edit budget uses the same escaped representation as optimizeField', async () => {
  const lines = [...Array(1800).fill(' "'), '-old()', '+new()'];
  const raw = { ...output, structuredPatch: [{ oldStart: 1, oldLines: 1801,
    newStart: 1, newLines: 1801, lines }] };
  expect(JSON.stringify(raw).length).toBeLessThan(16000);
  for (const value of [raw, JSON.stringify(raw)]) {
    expect(JSON.stringify(value, null, 2).length).toBeGreaterThan(16000);
    const fields = { toolInput: JSON.stringify(input), toolOutput: value };
    const before = JSON.stringify(fields);
    let calls = 0;
    const result = await optimizeObservationFields(fields, async () => { calls++; return null; },
      { sessionDbId: 0, toolName: 'Edit' });
    expect(calls).toBe(0);
    expect(JSON.stringify(result.toolOutput, null, 2).length).toBeLessThan(16000);
    expect(result.toolOutput).toMatchObject({ oldString: 'old()', newString: 'new()' });
    expect(JSON.stringify(fields)).toBe(before);
  }
});

test('unknown, inconsistent, modified, or failed Edit results keep the normal path', async () => {
  for (const change of [{ userModified: true }, { oldString: 'different' }, { error: 'failed' },
    { extraNativeField: true }, { structuredPatch: [{ ...output.structuredPatch[0], oldLines: 2 }] },
    { structuredPatch: [{ ...output.structuredPatch[0], lines: ['-' + prefix + 'other()', '+' + prefix + 'new()'] }] }]) {
    const raw = { ...output, ...change };
    let calls = 0;
    const result = await optimizeObservationFields({ toolInput: input, toolOutput: raw }, async () => { calls++; return null; }, { sessionDbId: 0, toolName: 'Edit' });
    expect(calls).toBe(1);
    expect(result.toolOutput).toBe(raw);
  }
});
