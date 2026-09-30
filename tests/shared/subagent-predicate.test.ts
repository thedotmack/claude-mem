import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { isSubagentEvent, mainAgentRowSql } from '../../src/shared/subagent-predicate.js';

const CASES: Array<{ label: string; agentId: string | null; agentType: string | null; subagent: boolean }> = [
  { label: 'main session (neither field)', agentId: null, agentType: null, subagent: false },
  { label: 'Claude Code subagent (both fields)', agentId: 'agent-42', agentType: 'Explore', subagent: true },
  { label: 'transcript-watch / Grok Bot seat (agent_id alone)', agentId: 'grok-seat-7', agentType: null, subagent: false },
  { label: '`claude --agent` main thread (agent_type alone)', agentId: null, agentType: 'reviewer', subagent: false },
  { label: 'empty strings count as absent', agentId: '', agentType: 'Explore', subagent: false },
];

describe('isSubagentEvent', () => {
  for (const c of CASES) {
    it(`${c.label} -> ${c.subagent ? 'subagent' : 'main agent'}`, () => {
      expect(isSubagentEvent(c.agentId, c.agentType)).toBe(c.subagent);
    });
  }
});

describe('mainAgentRowSql agrees with isSubagentEvent', () => {
  it('selects exactly the rows the TypeScript predicate calls main-agent', () => {
    const db = new Database(':memory:');
    try {
      db.run('CREATE TABLE observations (id INTEGER PRIMARY KEY, agent_id TEXT, agent_type TEXT)');
      const insert = db.prepare('INSERT INTO observations (id, agent_id, agent_type) VALUES (?, ?, ?)');
      CASES.forEach((c, index) => insert.run(index, c.agentId, c.agentType));

      const selected = (db.prepare(`SELECT id FROM observations o WHERE ${mainAgentRowSql('o')} ORDER BY id`)
        .all() as Array<{ id: number }>).map(row => row.id);
      const expected = CASES
        .map((c, index) => ({ index, main: !isSubagentEvent(c.agentId, c.agentType) }))
        .filter(row => row.main)
        .map(row => row.index);

      expect(selected).toEqual(expected);
    } finally {
      db.close();
    }
  });
});
