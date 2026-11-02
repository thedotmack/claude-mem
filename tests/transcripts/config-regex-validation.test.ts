import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTranscriptWatchConfig } from '../../src/services/transcripts/config.js';
import { matchesRule } from '../../src/services/transcripts/field-utils.js';

for (const [match, location] of [
  [{ path: 'type', regex: '[' }, 'schemas.local.events[0].match.regex'],
  [{ all: [{ any: [{ path: 'type', regex: '(' }] }] }, 'schemas.local.events[0].match.all[0].any[0].regex'],
] as const) {
  it(`rejects unusable regex rules before starting a watch: ${JSON.stringify(match)}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'cmem-regex-config-'));
    try {
      const config = join(root, 'watch.json');
      writeFileSync(config, JSON.stringify({ version: 1, schemas: { local: { name: 'local', events: [
        { name: 'turn', action: 'user_message', match },
      ] } }, watches: [{ name: 'local', path: 'local.jsonl', schema: 'local' }] }));
      expect(() => loadTranscriptWatchConfig(config)).toThrow(`Invalid transcript watch config: ${config} (${location} must be a valid regular expression)`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

it('loads and applies a valid regex unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'cmem-regex-config-'));
  try {
    const config = join(root, 'watch.json');
    writeFileSync(config, JSON.stringify({ version: 1, watches: [{ name: 'local', path: 'local.jsonl', schema: {
      name: 'local', events: [{ name: 'turn', action: 'user_message', match: { path: 'type', regex: '^user(?:_message)?$' } }],
    } }] }));
    const schema = loadTranscriptWatchConfig(config).watches[0].schema;
    if (typeof schema === 'string') throw new Error('Expected inline schema');
    expect(matchesRule({ type: 'user_message' }, schema.events[0].match, schema)).toBe(true);
    expect(matchesRule({ type: 'assistant' }, schema.events[0].match, schema)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
