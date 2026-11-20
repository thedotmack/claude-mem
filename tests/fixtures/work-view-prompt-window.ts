import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { readAgentRecords } from '../../src/services/work-view/agent-view.mjs';
import { reduceWorkState } from '../../src/services/work-view/data-source.mjs';

export const NOW = Date.parse('2026-11-01T12:00:00Z');

/** A real migrated default reader window, interleaved by prompt number. */
export function promptWindow(sessionCount = 600, promptsPerSession = 20) {
  const database = new Database(':memory:');
  new SessionStore(database);
  const session = database.prepare(`INSERT INTO sdk_sessions
    (id, content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const prompt = database.prepare(`INSERT INTO user_prompts
    (id, session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const observation = database.prepare(`INSERT INTO observations
    (id, memory_session_id, project, prompt_number, type, title, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, 'discovery', ?, ?, ?)`);
  const started = NOW - 3_600_000;
  const project = (id: number) => 'owned-repo-' + (id % 3);
  const initial = (id: number) => id % 2 ? 'Build the requested feature ' + id : 'Read AGENTS.md and follow it.';
  database.transaction(() => {
    for (let id = 1; id <= sessionCount; id++) {
      session.run(id, 'content-' + id, 'memory-' + id, project(id),
        id % 2 ? 'claude' : 'codex', initial(id), new Date(started).toISOString(), started);
    }
    for (let number = 1; number <= promptsPerSession; number++) for (let id = 1; id <= sessionCount; id++) {
      const at = started + number * 10_000 + id;
      const text = number === 1 ? initial(id)
        : number === 2 ? 'Implement the requested feature ' + id
        : 'Update the next detail ' + number + ' for feature ' + id;
      prompt.run((number - 1) * sessionCount + id, id, 'content-' + id, number, text, new Date(at).toISOString(), at);
    }
    // Fill the default observation window without increasing any reader limit.
    for (let id = 1; id <= Math.min(150, sessionCount); id++) for (let number = 1; number <= 2; number++) {
      const at = started + 300_000 + id * 2 + number;
      observation.run((id - 1) * 2 + number, 'memory-' + id, project(id), number,
        'Recorded feature ' + id + ' turn ' + number, new Date(at).toISOString(), at);
    }
  })();
  const state = reduceWorkState([], {
    currentProject: 'owned-repo-0',
    currentProjectScope: ['owned-repo-0', 'owned-repo-1', 'owned-repo-2'],
  });
  const read = () => readAgentRecords(database, { workState: state, now: NOW });
  return { database, state, read };
}
