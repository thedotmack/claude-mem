import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadTranscriptWatchConfig } from '../../src/services/transcripts/config.js';
import { loadWatchState } from '../../src/services/transcripts/state.js';

describe('BOM-prefixed transcript JSON documents', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function file(value: unknown, bom: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'transcript-bom-')); dirs.push(dir);
    const pathname = join(dir, 'document.json');
    writeFileSync(pathname, (bom ? '\uFEFF' : '') + JSON.stringify(value)); return pathname;
  }
  it('loads the configured watches from a UTF-8 BOM document', () => {
    const config = { version: 1, schemas: {}, watches: [{ name: 'codex', path: '/tmp/sessions/*.jsonl', schema: 'codex' }] };
    expect(loadTranscriptWatchConfig(file(config, true)).watches).toEqual(config.watches);
  });
  it('retains durable offsets and partial frames rather than replaying from zero', () => {
    const state = { offsets: { '/tmp/session.jsonl.zst': 4096 }, partials: { '/tmp/session.jsonl.zst': '{"event":' }, frameLines: { '/tmp/session.jsonl.zst': 2 }, cwds: { '/tmp/session.jsonl.zst': '/workspace' } };
    expect(loadWatchState(file(state, true))).toEqual(state);
  });
  it('keeps unprefixed JSON and invalid-config behavior', () => {
    expect(loadWatchState(file({ offsets: { example: 5 } }, false))).toEqual({ offsets: { example: 5 } });
    expect(() => loadTranscriptWatchConfig(file({ version: 1 }, true))).toThrow('Invalid transcript watch config');
  });
});
