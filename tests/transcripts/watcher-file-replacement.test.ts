import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
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
