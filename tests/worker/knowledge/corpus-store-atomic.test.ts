import { describe, it, expect, spyOn } from 'bun:test';
import * as fs from 'fs';
import { join } from 'path';
import { CorpusStore } from '../../../src/services/worker/knowledge/CorpusStore.js';
import { paths } from '../../../src/shared/paths.js';
import type { CorpusFile } from '../../../src/services/worker/knowledge/types.js';

function corpus(name: string, description: string): CorpusFile {
  return { version: 1, name, description, created_at: '2026-11-02', updated_at: '2026-11-02',
    filter: {}, stats: { observation_count: 0, token_estimate: 0,
      date_range: { earliest: '', latest: '' }, type_breakdown: {} },
    system_prompt: '', session_id: null, observations: [] };
}

describe('CorpusStore interrupted writes', () => {
  it('preserves an existing corpus when the replacement write fails after writing bytes', () => {
    const store = new CorpusStore();
    const name = `atomic-failure-${process.pid}`;
    const original = corpus(name, 'previous successful build');
    store.write(original);
    const file = join(paths.corpora(), `${name}.corpus.json`);
    const before = fs.readFileSync(file, 'utf8');
    const writeFile = fs.writeFileSync;
    const writeFd = fs.writeSync;
    const failure = Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
    let injected = 0;
    const fileSpy = spyOn(fs, 'writeFileSync').mockImplementation((target: any) => {
      writeFile(target, '{'); injected++; throw failure;
    });
    const fdSpy = spyOn(fs, 'writeSync').mockImplementation((fd: number) => {
      writeFd(fd, Buffer.from('{')); injected++; throw failure;
    });
    try {
      expect(() => store.write(corpus(name, 'new build'))).toThrow('simulated disk full');
      expect(injected).toBe(1);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(store.read(name)).toEqual(original);
      expect(fs.readdirSync(paths.corpora()).filter(entry => entry.includes(name) && entry.endsWith('.tmp'))).toEqual([]);
    } finally {
      fileSpy.mockRestore(); fdSpy.mockRestore(); store.delete(name);
    }
  });
});
