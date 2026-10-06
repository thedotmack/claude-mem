import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { isZstdSupported } from '../../src/services/transcripts/zstd-frames.js';
import { loadWatchState } from '../../src/services/transcripts/state.js';
const roots: string[] = [];
const watchers: TranscriptWatcher[] = [];
afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
};
for (const restart of [false, true]) {
  it(`reads an equal-size atomic replacement from byte zero${restart ? ' across restart' : ''}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-file-replacement-')); roots.push(root);
    const file = join(root, 'session.jsonl'); const state = join(root, 'state.json');
    const first = JSON.stringify({ cwd: '/first' }) + '\n';
    const second = JSON.stringify({ cwd: '/other' }) + '\n';
    expect(Buffer.byteLength(second)).toBe(Buffer.byteLength(first));
    writeFileSync(file, first);
    const schema = { name: 'context', sessionIdPath: 'session', events: [{ name: 'context', action: 'session_context' as const, fields: { sessionId: { value: 's' }, cwd: 'cwd' } }] };
    const config = { version: 1 as const, watches: [{ name: 'context', path: file, schema }] };
    const before = new TranscriptWatcher(config, state); watchers.push(before); await before.start();
    await waitFor(() => { try { return JSON.parse(readFileSync(state, 'utf8')).cwds?.[file] === '/first'; } catch { return false; } });
    if (restart) before.stop();
    const replacement = join(root, 'replacement'); writeFileSync(replacement, second); renameSync(replacement, file);
    if (restart) { const after = new TranscriptWatcher(config, state); watchers.push(after); await after.start(); }
    await waitFor(() => JSON.parse(readFileSync(state, 'utf8')).cwds?.[file] === '/other');
    const saved = JSON.parse(readFileSync(state, 'utf8'));
    expect(saved.cwds[file]).toBe('/other');
    expect(saved.offsets[file]).toBe(statSync(file).size);
    expect(saved.fileIdentities[file]).toBe(`${statSync(file).dev}:${statSync(file).ino}`);
  });
}

// Native zstd frames for a completed context plus an unfinished next record,
// and a larger replacement containing one complete context record. Fixed
// frames exercise the production decoder without requiring a compressor.
const partialFrame = Buffer.from(
  '28b52ffd2019c900007b22637764223a222f6669727374227d0a7b22637764223a22',
  'hex'
);
const replacementFrame = Buffer.from(
  '28b52ffd20210901007b22637764223a222f7265706c6163656d656e742d6469726563746f7279227d0a',
  'hex'
);
for (const restart of [false, true]) {
  it.skipIf(!isZstdSupported())(
    `clears a saved zstd partial and reads a replacement's first frame${restart ? ' across restart' : ''}`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'cm-zstd-file-replacement-'));
      roots.push(root);
      const file = join(root, 'session.jsonl.zstd');
      const state = join(root, 'state.json');
      writeFileSync(file, partialFrame);
      const schema = {
        name: 'context',
        sessionIdPath: 'session',
        events: [{
          name: 'context',
          action: 'session_context' as const,
          fields: { sessionId: { value: 's' }, cwd: 'cwd' },
        }],
      };
      const config = { version: 1 as const, watches: [{ name: 'context', path: file, schema }] };
      const before = new TranscriptWatcher(config, state);
      watchers.push(before);
      await before.start();
      await waitFor(() => {
        const saved = loadWatchState(state);
        return saved.cwds?.[file] === '/first' && saved.partials?.[file] === '{"cwd":"';
      });
      const checkpoint = loadWatchState(state);
      expect(checkpoint.offsets[file]).toBe(partialFrame.length);
      expect(checkpoint.partials?.[file]).toBe('{"cwd":"');
      if (restart) before.stop();
      const replacement = join(root, 'replacement');
      writeFileSync(replacement, replacementFrame);
      // A larger file prevents truncation detection from masking identity loss.
      expect(replacementFrame.length).toBeGreaterThan(partialFrame.length);
      renameSync(replacement, file);
      if (restart) {
        const after = new TranscriptWatcher(config, state);
        watchers.push(after);
        await after.start();
      }
      await waitFor(() => loadWatchState(state).cwds?.[file] === '/replacement-directory');
      const saved = loadWatchState(state);
      expect(saved.cwds?.[file]).toBe('/replacement-directory');
      expect(saved.offsets[file]).toBe(replacementFrame.length);
      expect(saved.partials?.[file]).toBeUndefined();
      expect(saved.frameLines?.[file]).toBeUndefined();
      expect(saved.fileIdentities?.[file]).toBe(`${statSync(file).dev}:${statSync(file).ino}`);
    }
  );
}
