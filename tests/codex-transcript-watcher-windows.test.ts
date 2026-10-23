import { afterEach, describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TranscriptWatcher } from '../src/services/transcripts/watcher.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function newWatcher(): TranscriptWatcher {
  const root = mkdtempSync(join(tmpdir(), 'cm-codex-watcher-windows-'));
  roots.push(root);
  return new TranscriptWatcher({ version: 1, watches: [] }, join(root, 'state.json'));
}

describe('Codex transcript ingestion on Windows (#2192)', () => {
  it('turns backslashes into forward slashes before a path is used as a glob', () => {
    const watcher = newWatcher() as any;
    expect(watcher.normalizeGlobPattern('C:\\Users\\me\\.codex\\sessions\\**\\*.jsonl'))
      .toBe('C:/Users/me/.codex/sessions/**/*.jsonl');
  });

  it('pokes an already-tailed file on a root-watcher event instead of returning early', () => {
    const watcher = newWatcher() as any;
    const watchRoot = roots[0];
    const filePath = join(watchRoot, 'rollout.jsonl');
    writeFileSync(filePath, '');
    let pokes = 0;
    watcher.tailers.set(filePath.replace(/\\/g, '/'), { poke: () => { pokes++; }, close: () => {} });

    watcher.handleRootWatchEvent(watchRoot, join(watchRoot, '*.jsonl'), {}, {}, 'rollout.jsonl');

    expect(pokes).toBe(1);
  });
});
