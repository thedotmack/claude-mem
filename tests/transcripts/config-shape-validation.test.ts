import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTranscriptWatchConfig } from '../../src/services/transcripts/config.js';
import { runTranscriptCommand } from '../../src/services/transcripts/cli.js';
const root = mkdtempSync(join(tmpdir(), 'cm-config-shapes-'));
const configPath = join(root, 'watch.json');
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe('transcript config validation', () => {
  for (const input of [{version:2,watches:[]},{version:1,watches:{}},{version:1,watches:[null]},
    {version:1,watches:[{name:'owned',path:42,schema:'owned'}]},
    {version:1,watches:[{name:'owned',path:'owned.jsonl',schema:{name:'owned',events:{}}}]},
    {version:1,watches:[{name:'owned',path:'owned.jsonl',schema:{name:'owned',events:[null]}}]}]) {
    it(`rejects watcher-breaking config ${JSON.stringify(input)}`, () => {
      writeFileSync(configPath, JSON.stringify(input));
      expect(() => loadTranscriptWatchConfig(configPath)).toThrow('Invalid transcript watch config');
    });
  }
  it('does not claim Config OK from the CLI for non-array watches', async () => {
    writeFileSync(configPath, JSON.stringify({version:1,watches:{}}));
    await expect(runTranscriptCommand('validate', ['--config', configPath])).rejects.toThrow('Invalid transcript watch config');
  });
});
