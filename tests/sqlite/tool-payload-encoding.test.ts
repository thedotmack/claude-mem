import { expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { computeToolUseContentHash, createToolUsesSchema, MAX_TOOL_PAYLOAD_BYTES, truncatePayload, upsertToolUse } from '../../src/services/sqlite/tool-uses.js';

for (const text of ['ascii', 'é', '漢', '🙂', 'a🙂漢éz', '\uD800x', 'x\uDC00', 'a\0🙂z']) {
  it(`preserves complete UTF-8 characters and the original byte count for ${JSON.stringify(text)}`, () => {
    const encoded = Buffer.from(text, 'utf8');
    for (let budget = 0; budget <= encoded.length + 1; budget++) {
      const accepted: string[] = [];
      let used = 0;
      // Decode once to express the UTF-8 replacement behavior for lone surrogates.
      for (const point of encoded.toString('utf8')) {
        const size = Buffer.byteLength(point);
        if (used + size > budget) break;
        accepted.push(point);
        used += size;
      }
      const expected = encoded.length <= budget ? text : `${accepted.join('')}…[truncated: ${encoded.length} bytes]`;
      expect(truncatePayload(text, budget)).toBe(expected);
    }
  });
}

it('retains the existing hash for omitted, empty, Unicode, NUL and oversized original fields', () => {
  const values = [undefined, null, '', 'a\0b', '漢🙂', '\uD800', '\uDC00', 'x'.repeat(MAX_TOOL_PAYLOAD_BYTES + 9)];
  for (const input of values) for (const output of values) {
    const expected = createHash('sha256').update(['Bash', input || '', output || ''].join('\0')).digest('hex').slice(0, 16);
    expect(computeToolUseContentHash('Bash', input, output)).toBe(expected);
  }
});

it('stores identical capped prefixes while retaining distinct original-content identities', () => {
  const db = new Database(':memory:');
  createToolUsesSchema(db);
  try {
    const prefix = '漢🙂x'.repeat(MAX_TOOL_PAYLOAD_BYTES / 8);
    const common = { contentSessionId: 'owned-session', project: 'owned-project', toolName: 'Bash', toolInput: '{}' };
    for (const suffix of ['first', 'other']) {
      upsertToolUse(db, { ...common, toolUseId: suffix, toolResponse: prefix + suffix });
    }
    const rows = db.query('SELECT tool_response, content_hash FROM tool_uses ORDER BY id').all() as Array<{ tool_response: string; content_hash: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].tool_response).toBe(`${prefix}…[truncated: ${MAX_TOOL_PAYLOAD_BYTES + 5} bytes]`);
    expect(rows[1].tool_response).toBe(rows[0].tool_response);
    expect(rows[0].content_hash).not.toBe(rows[1].content_hash);
  } finally { db.close(); }
});
