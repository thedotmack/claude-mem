import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_STATE_PATH, loadTranscriptWatchConfig } from '../../src/services/transcripts/config.js';
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

it('validates referenced schema events before claiming Config OK', async () => {
  writeFileSync(configPath, JSON.stringify({ version: 1, schemas: { owned: { name: 'owned', events: {} } },
    watches: [{ name: 'owned', path: 'owned.jsonl', schema: 'owned' }] }));
  await expect(runTranscriptCommand('validate', ['--config', configPath])).rejects.toThrow('Invalid transcript watch config');
});
for (const invalidEvent of [{ name: 'owned', action: 'user_message', match: { path: 42 } },
  { name: 'owned', action: 'user_message', fields: { prompt: { path: 42 } } },
  { name: 'owned', action: 'user_message', match: { all: [{ path: 42 }] } }]) {
  it(`rejects an invalid runtime event ${JSON.stringify(invalidEvent)}`, () => {
    writeFileSync(configPath, JSON.stringify({ version: 1, watches: [
      { name: 'owned', path: 'owned.jsonl', schema: { name: 'owned', events: [invalidEvent] } } ] }));
    expect(() => loadTranscriptWatchConfig(configPath)).toThrow('Invalid transcript watch config');
  });
}

describe('transcript config errors name what to fix', () => {
  const cases: Array<[input: unknown, problem: string]> = [
    [{ version: 2, watches: [] }, 'version must be 1'],
    [{ version: 1, watches: {} }, 'watches must be an array'],
    [{ version: 1, watches: [{ name: 'a', path: 'a.jsonl', schema: 'a' }, { name: 'b', path: 42, schema: 'b' }] },
      'watches[1].path must be a non-empty string'],
    [{ version: 1, schemas: { owned: { name: 'owned', events: {} } }, watches: [] }, 'schemas.owned.events must be an array'],
    [{ version: 1, watches: [{ name: 'owned', path: 'owned.jsonl', schema: { name: 'owned', events: [
      { name: 'turn', action: 'user_message', fields: { prompt: { coalesce: ['text', { path: 42 }] } } }] } }] },
      'watches[0].schema.events[0].fields.prompt.coalesce[1].path must be a string'],
  ];
  for (const [input, problem] of cases) {
    it(`reports "${problem}"`, () => {
      writeFileSync(configPath, JSON.stringify(input));
      expect(() => loadTranscriptWatchConfig(configPath))
        .toThrow(`Invalid transcript watch config: ${configPath} (${problem})`);
    });
  }

  it('treats a null stateFile as absent', () => {
    writeFileSync(configPath, JSON.stringify({ version: 1, watches: [], stateFile: null }));
    expect(loadTranscriptWatchConfig(configPath).stateFile).toBe(DEFAULT_STATE_PATH);
  });
});
