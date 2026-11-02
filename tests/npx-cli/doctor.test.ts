import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { hookLauncherCheck, probeChromaDiagnostics, treeSitterCliCheck } from '../../src/npx-cli/commands/doctor.js';
import { LAUNCHER_PROTOCOL } from '../../src/launcher/launcher-protocol.js';

// `npx claude-mem doctor` reads the worker's /api/admin/doctor `health.chroma`
// block (#3362). These rows are optional: a missing, malformed or unreachable
// payload must never produce a row or change the worker's own status.

const WORKER_URL = 'http://127.0.0.1:37777';
const OVERRIDES = ['onnxruntime>=1.20', 'protobuf<7', 'chromadb==1.5.9'];

let fetchSpy: ReturnType<typeof spyOn> | null = null;
let requestedUrls: string[] = [];

function workerReportingChroma(chroma: unknown, status = 200): void {
  fetchSpy?.mockImplementation(async (input: RequestInfo | URL) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify({ health: { chroma } }), { status });
  });
}

function chromaState(overrides: Record<string, unknown> = {}) {
  return {
    count: 1,
    lastExit: { timestamp: '2026-07-23T12:00:00.000Z', code: null, signal: 'SIGSEGV' },
    chromaMcpVersion: '0.2.6',
    dependencyOverrides: OVERRIDES,
    prewarm: { consecutiveFailures: 0, state: 'ok' },
    ...overrides,
  };
}

describe('npx doctor Chroma diagnostics', () => {
  beforeEach(() => {
    requestedUrls = [];
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  it('reports the last exit by signal with versions and overrides', async () => {
    workerReportingChroma(chromaState());

    const [row, ...rest] = await probeChromaDiagnostics(WORKER_URL);

    expect(requestedUrls).toEqual([`${WORKER_URL}/api/admin/doctor`]);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ name: 'Chroma child exits', status: 'warn', required: false });
    expect(row.detail).toContain('1 unexpected exit(s) since the worker started, last by signal SIGSEGV');
    expect(row.detail).toContain('2026-07-23T12:00:00.000Z');
    expect(row.detail).toContain('chroma-mcp 0.2.6');
    expect(row.detail).toContain('onnxruntime>=1.20, protobuf<7, chromadb==1.5.9');
  });

  it('reports a crash inside chroma-mcp as uvx\'s exit code', async () => {
    // uvx is the direct child: a SIGSEGV in the Python engine arrives as uvx's
    // exit code, with no signal on uvx itself.
    workerReportingChroma(chromaState({
      count: 3,
      lastExit: { timestamp: '2026-07-23T12:00:00.000Z', code: 139, signal: null },
    }));

    const [row] = await probeChromaDiagnostics(WORKER_URL);

    expect(row.detail).toContain('3 unexpected exit(s) since the worker started, last by exit code 139');
  });

  it('warns when the prewarm breaker has paused or stopped spawning uvx', async () => {
    workerReportingChroma(chromaState({ count: 0, lastExit: null, prewarm: { consecutiveFailures: 20, state: 'stopped' } }));
    const stopped = await probeChromaDiagnostics(WORKER_URL);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ name: 'Chroma prewarm', status: 'warn', required: false });
    expect(stopped[0].detail).toContain('stopped after 20 consecutive uvx failures');

    workerReportingChroma(chromaState({ count: 0, lastExit: null, prewarm: { consecutiveFailures: 6, state: 'paused' } }));
    const paused = await probeChromaDiagnostics(WORKER_URL);
    expect(paused[0].detail).toContain('paused after 6 consecutive uvx failures');
  });

  it('warns when a corrupt collection was dropped and is being rebuilt (#3202)', async () => {
    workerReportingChroma(chromaState({
      count: 0,
      lastExit: null,
      collectionDrop: {
        collection: 'cm__claude-mem',
        droppedAt: '2026-09-30T10:00:00.000Z',
        documentCount: 48213,
        error: 'Failed to apply logs to the hnsw segment writer',
      },
    }));

    const rows = await probeChromaDiagnostics(WORKER_URL);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Chroma collection', status: 'warn', required: false });
    expect(rows[0].detail).toContain('cm__claude-mem had a corrupt HNSW segment and was dropped at 2026-09-30T10:00:00.000Z (48213 documents)');
    expect(rows[0].detail).toContain('rebuilt from SQLite');
  });

  it('shows no rows for a healthy child, including from an older worker without prewarm state', async () => {
    workerReportingChroma({ ...chromaState({ count: 0, lastExit: null }), prewarm: undefined });

    expect(await probeChromaDiagnostics(WORKER_URL)).toEqual([]);
  });

  it('shows no rows when the worker is unreachable or the endpoint fails', async () => {
    fetchSpy?.mockImplementation(async () => { throw new Error('connection refused'); });
    expect(await probeChromaDiagnostics(WORKER_URL)).toEqual([]);

    workerReportingChroma(chromaState(), 500);
    expect(await probeChromaDiagnostics(WORKER_URL)).toEqual([]);
  });

  it('ignores a missing or malformed admin Chroma payload', async () => {
    workerReportingChroma({ count: 'not-a-number' });
    expect(await probeChromaDiagnostics(WORKER_URL)).toEqual([]);

    workerReportingChroma(chromaState({ prewarm: { consecutiveFailures: 3, state: 'exploded' } }));
    expect(await probeChromaDiagnostics(WORKER_URL)).toEqual([]);

    workerReportingChroma(undefined);
    expect(await probeChromaDiagnostics(WORKER_URL)).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('npx doctor tree-sitter CLI row', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'doctor-tree-sitter-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('checks the executable at the plugin root the worker runs from', async () => {
    const cliDir = join(root, 'node_modules', 'tree-sitter-cli');
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, 'tree-sitter'), "#!/usr/bin/env node\nprocess.stdout.write('tree-sitter 0.26.8\\n');\n");
    chmodSync(join(cliDir, 'tree-sitter'), 0o755);

    expect(await treeSitterCliCheck(root)).toMatchObject({ name: 'tree-sitter CLI', status: 'ok', required: false });
  });

  function writeCli(dir: string, script: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tree-sitter'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, 'tree-sitter'), 0o755);
  }

  it('warns with the repair hint when the executable is missing', async () => {
    const row = await treeSitterCliCheck(root, join(root, 'empty-path'));
    expect(row).toMatchObject({ status: 'warn', required: false });
    expect(row.detail).toContain('missing at');
    expect(row.detail).toContain('npx claude-mem repair');
    expect(row.detail).toContain('on PATH');
  });

  // #4858: musl has no tree-sitter release build, so the package-local one is
  // missing, but the parser falls back to a working tree-sitter on PATH.
  it('is ok when the package-local executable is missing but a working one is on PATH', async () => {
    const pathDir = join(root, 'path-bin');
    writeCli(pathDir, 'echo "tree-sitter 0.26.9"');

    const row = await treeSitterCliCheck(root, pathDir);
    expect(row).toMatchObject({ status: 'ok', detail: 'tree-sitter on PATH' });
  });

  it('is ok when the package-local executable cannot run but a working one is on PATH', async () => {
    writeCli(join(root, 'node_modules', 'tree-sitter-cli'), "echo 'Error loading shared library' >&2\nexit 127");
    const pathDir = join(root, 'path-bin');
    writeCli(pathDir, 'echo "tree-sitter 0.26.9"');

    const row = await treeSitterCliCheck(root, pathDir);
    expect(row).toMatchObject({ status: 'ok', detail: join(pathDir, 'tree-sitter') });
  });

  it('reports why the package-local executable cannot run when nothing on PATH works', async () => {
    writeCli(join(root, 'node_modules', 'tree-sitter-cli'), "echo 'Error loading shared library' >&2\nexit 127");

    const row = await treeSitterCliCheck(root, join(root, 'empty-path'));
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('Error loading shared library');
  });
});

// `npx claude-mem doctor` runs with npx's own `node_modules/.bin` first on PATH, so the first `claude-mem` there is
// this CLI, not the hook launcher. Hooks run outside npx and find the launcher, so doctor must look past itself.
describe.skipIf(process.platform === 'win32')('npx doctor hook launcher', () => {
  let root: string;
  let npxBin: string;
  let runningCli: string;
  let launcherDir: string;

  function executable(path: string, output: string): void {
    writeFileSync(path, `#!/bin/sh\necho ${output}\n`);
    chmodSync(path, 0o755);
  }

  function host(pathValue: string) {
    return { homeDirectory: root, platform: process.platform, environmentVariables: { PATH: pathValue } };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'doctor-launcher-'));
    // npx runs packages from npm's cache, `<cache>/_npx/<hash>/node_modules`.
    const cliDir = join(root, '_npx', 'abc123', 'node_modules', 'claude-mem', 'dist', 'npx-cli');
    npxBin = join(root, '_npx', 'abc123', 'node_modules', '.bin');
    launcherDir = join(root, 'local-bin');
    mkdirSync(cliDir, { recursive: true });
    mkdirSync(npxBin, { recursive: true });
    mkdirSync(launcherDir, { recursive: true });
    runningCli = join(cliDir, 'index.js');
    executable(runningCli, '13.41.0');
    symlinkSync('../claude-mem/dist/npx-cli/index.js', join(npxBin, 'claude-mem'));
    executable(join(launcherDir, 'claude-mem'), String(LAUNCHER_PROTOCOL));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('checks the launcher behind its own npx bin, not itself', () => {
    const result = hookLauncherCheck(host(`${npxBin}:${launcherDir}:/usr/bin:/bin`), runningCli);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain(join(launcherDir, 'claude-mem'));
  });

  it('still fails when another claude-mem that is not the launcher comes first', () => {
    const otherDir = join(root, 'other');
    mkdirSync(otherDir);
    executable(join(otherDir, 'claude-mem'), '13.15.0');
    const result = hookLauncherCheck(host(`${otherDir}:${launcherDir}:/usr/bin:/bin`), runningCli);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(join(otherDir, 'claude-mem'));
  });

  it('still fails when a persistent install of this CLI comes before the launcher', () => {
    // A global `npm i -g claude-mem` is the CLI, not the launcher, and hooks reach it first. Only npx's copy is skipped.
    const globalRoot = join(root, 'npm-global');
    const globalCli = join(globalRoot, 'lib', 'node_modules', 'claude-mem', 'dist', 'npx-cli', 'index.js');
    const globalBin = join(globalRoot, 'bin');
    mkdirSync(join(globalCli, '..'), { recursive: true });
    mkdirSync(globalBin, { recursive: true });
    executable(globalCli, '13.41.0');
    symlinkSync(globalCli, join(globalBin, 'claude-mem'));
    const result = hookLauncherCheck(host(`${globalBin}:${launcherDir}:/usr/bin:/bin`), globalCli);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(join(globalBin, 'claude-mem'));
  });

  it('reports a missing launcher when the only claude-mem on PATH is itself', () => {
    const result = hookLauncherCheck(host(`${npxBin}:/usr/bin:/bin`), runningCli);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not on PATH');
  });
});
