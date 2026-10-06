import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPriorMessages } from '../../src/services/context/ObservationCompiler.js';
it('reads assistant rows serialized with JSON whitespace', () => {
  const directory = mkdtempSync(join(tmpdir(), 'prior-json-'));
  try {
    const path = join(directory, 'session.jsonl');
    const old = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Older reply' }] },
    });
    const latest =
      '{"type" : "assistant", "message": {"content": [{"type": "text", "text": "Latest reply"}]}}';
    writeFileSync(path, `${old}\n${latest}\n`);
    expect(extractPriorMessages(path).assistantMessage).toBe('Latest reply');
    writeFileSync(
      path,
      '{"type": "assistant", "message": {"content": [{"type": "text", "text": "Python style reply"}]}}\n'
    );
    expect(extractPriorMessages(path).assistantMessage).toBe('Python style reply');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
