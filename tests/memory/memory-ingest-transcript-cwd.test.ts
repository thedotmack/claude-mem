import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestMemorySource, scanMemorySource } from '../../src/services/memory/ingest.js';

describe('native memory project lookup across transcript chunks', () => {
  let root: string;
  let cwd: string;
  let memory: string;
  let transcript: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memory-transcript-cwd-'));
    cwd = join(root, 'demo-project');
    mkdirSync(cwd);
    const projectDir = join(root, '-workspace-demo-project');
    memory = join(projectDir, 'memory');
    mkdirSync(memory, { recursive: true });
    transcript = join(projectDir, 'session.jsonl');
    writeFileSync(join(memory, 'deployment.md'), '# Deployment\nKeep incremental rollouts.');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolves the native user record after a long first prompt', () => {
    // Claude Code emits queue records before the first user record. Its cwd
    // is in that record even when pasted diagnostics make it exceed 16 KiB.
    const lines = [
      { type: 'queue-operation', operation: 'enqueue', sessionId: 'native-session' },
      { type: 'queue-operation', operation: 'remove', sessionId: 'native-session' },
      { type: 'user', cwd, message: { role: 'user', content: 'deployment diagnostic line\n'.repeat(1400) } },
    ];
    writeFileSync(transcript, lines.map(row => JSON.stringify(row)).join('\n') + '\n');
    const [ref] = scanMemorySource(memory, { root });
    expect(ref.cwd).toBe(cwd);
    expect(ref.project).toBe('demo-project');
  });

  it('keeps requireCwd imports instead of silently skipping their notes', async () => {
    writeFileSync(transcript, JSON.stringify({ type: 'user', cwd, message: { content: 'log line\n'.repeat(5000) } }) + '\n');
    const stored: string[] = [];
    const report = await ingestMemorySource(memory, { root, requireCwd: true }, {
      storeMemoryObservation: async observation => {
        stored.push(observation.project);
        return { id: 1, deduped: false };
      },
    });
    expect(stored).toEqual(['demo-project']);
    expect(report).toMatchObject({ stored: 1, skipped: 0, cwdUnresolvedDirs: 0 });
  });

  it('preserves a cwd whose UTF-8 character crosses the read boundary', () => {
    const unicodeCwd = join(root, '研究-project');
    mkdirSync(unicodeCwd);
    const before = '{"type":"user","message":{"content":"';
    const after = '"},"cwd":"';
    const encodedCwd = JSON.stringify(unicodeCwd).slice(1, -1);
    const asciiCwd = encodedCwd.slice(0, encodedCwd.indexOf('研'));
    const padding = 'x'.repeat(16383 - Buffer.byteLength(before + after + asciiCwd));
    writeFileSync(transcript, before + padding + after + encodedCwd + '"}\n');
    const [ref] = scanMemorySource(memory, { root });
    expect(ref.cwd).toBe(unicodeCwd);
    expect(ref.project).toBe('研究-project');
  });

  it('reads a complete final record without a trailing newline after long metadata', () => {
    const metadata = JSON.stringify({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: 'x'.repeat(20000) } });
    writeFileSync(transcript, metadata + '\nnot-json\n' + JSON.stringify({ type: 'user', cwd }));
    expect(scanMemorySource(memory, { root })[0].cwd).toBe(cwd);
  });

  it('retains the first cwd rather than a later changed working directory', () => {
    writeFileSync(transcript, [
      { type: 'user', cwd },
      { type: 'assistant', cwd: join(root, 'other-project'), message: { content: 'x'.repeat(40000) } },
    ].map(row => JSON.stringify(row)).join('\n'));
    expect(scanMemorySource(memory, { root })[0].cwd).toBe(cwd);
  });

  it('keeps the unresolved fallback for a transcript without a usable cwd', () => {
    writeFileSync(transcript, '{"type":"user","message":');
    const [ref] = scanMemorySource(memory, { root });
    expect(ref.cwd).toBeUndefined();
    expect(ref.project).toBe('project');
  });
});
