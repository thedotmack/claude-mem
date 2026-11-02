import { afterAll, beforeEach, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { scanTokenUsage } from '../../../src/services/prompt-import/token-usage.js';

const GENERATED = join(import.meta.dir, '.generated', `claude-token-whitespace-${process.pid}`);
let home: string;
let sequence = 0;
beforeEach(() => {
  home = join(GENERATED, `home-${sequence++}`);
  mkdirSync(join(home, '.claude/projects/example'), { recursive: true });
});
afterAll(() => rmSync(GENERATED, { recursive: true, force: true }));

for (const spaced of [false, true]) {
  it(`counts Claude assistant usage from ${spaced ? 'spaced' : 'compact'} JSONL`, async () => {
    const record = { type: 'assistant', timestamp: '2026-10-10T00:00:00.000Z',
      message: { id: 'native-response', role: 'assistant', content: [{ type: 'text', text: 'answer' }],
        usage: { input_tokens: 4, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 10 } } };
    const line = spaced ? JSON.stringify(record).replace(/"type":/g, '"type" :\t') : JSON.stringify(record);
    writeFileSync(join(home, '.claude/projects/example/session.jsonl'), line + '\n');
    const result = await scanTokenUsage({ homeDirectory: home, sinceEpochMs: 0, agents: ['claude-code'] });
    expect(result.agents[0].tokens).toBe(164);
    expect(result.agents[0].firstRecordAt).toBe(record.timestamp);
  });
}
