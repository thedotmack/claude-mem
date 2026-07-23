import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { runDoctorCommand } from '../../src/npx-cli/commands/doctor.js';

let fetchSpy: ReturnType<typeof spyOn> | null = null;
let consoleLogSpy: ReturnType<typeof spyOn> | null = null;
let exitSpy: ReturnType<typeof spyOn> | null = null;
let output: string[] = [];

function captureDoctorOutput(): void {
  output = [];
  consoleLogSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output.push(args.join(' '));
  });
  exitSpy = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
}

describe('npx doctor Chroma diagnostics', () => {
  beforeEach(() => {
    output = [];
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      return new Response(JSON.stringify({
        health: {
          chroma: {
            count: 1,
            lastExit: { timestamp: '2026-07-23T12:00:00.000Z', code: null, signal: 'SIGSEGV' },
            chromaMcpVersion: '0.2.6',
            dependencyOverrides: ['onnxruntime>=1.20', 'protobuf<7', 'chromadb==1.0.16'],
          },
        },
      }), { status: 200 });
    });
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    consoleLogSpy?.mockRestore();
    consoleLogSpy = null;
    exitSpy?.mockRestore();
    exitSpy = null;
  });

  it('renders the warn-only exact Chroma child exit detail', async () => {
    captureDoctorOutput();

    await runDoctorCommand();

    const text = output.join('\n');
    expect(text).toContain('Chroma child exits');
    expect(text).toContain('1 (signal SIGSEGV)');
    expect(text).toContain('2026-07-23T12:00:00.000Z');
    expect(text).toContain('chroma-mcp 0.2.6');
    expect(text).toContain('onnxruntime>=1.20, protobuf<7, chromadb==1.0.16');
  });

  it('does not fabricate crash state when the worker is unreachable', async () => {
    captureDoctorOutput();
    fetchSpy?.mockImplementation(async () => { throw new Error('connection refused'); });

    await runDoctorCommand();

    const text = output.join('\n');
    expect(text).toContain('Worker daemon');
    expect(text).not.toContain('Chroma child exits');
  });

  it('ignores a missing or malformed admin Chroma payload', async () => {
    captureDoctorOutput();
    fetchSpy?.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      return new Response(JSON.stringify({ health: { chroma: { count: 'not-a-number' } } }), { status: 200 });
    });

    await runDoctorCommand();

    const text = output.join('\n');
    expect(text).toContain('Worker daemon');
    expect(text).not.toContain('Chroma child exits');
  });
});
