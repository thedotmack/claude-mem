import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { countToolUses, createToolUsesSchema, queryToolUses, upsertToolUse, type ToolUseQueryFilters } from '../../src/services/sqlite/tool-uses.js';
let db: Database;
afterEach(() => db?.close());
for (const filters of [{ memorySessionId: 'memory-a' }, { sessionDbId: 1 }, { platformSource: 'codex' }, { toolName: ['Read'] }] satisfies ToolUseQueryFilters[]) {
  it(`applies ${Object.keys(filters)[0]} to tallies as well as listings`, () => {
    db = new Database(':memory:'); createToolUsesSchema(db);
    upsertToolUse(db, { toolUseId: 'a', contentSessionId: 'content-a', project: 'project',
      memorySessionId: 'memory-a', sessionDbId: 1, platformSource: 'codex', toolName: 'Read' });
    upsertToolUse(db, { toolUseId: 'b', contentSessionId: 'content-b', project: 'project',
      memorySessionId: 'memory-b', sessionDbId: 2, platformSource: 'claude-code', toolName: 'Write' });
    expect(queryToolUses(db, filters).map(row => row.tool_name)).toEqual(['Read']);
    expect(countToolUses(db, filters)).toEqual([{ tool_name: 'Read', uses: 1 }]);
  });
}
