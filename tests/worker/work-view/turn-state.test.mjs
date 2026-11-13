// Whose move a conversation is comes from the end of its transcript. Records here have the shape Claude Code 2.1 and
// Codex 0.166 write (keys kept, text replaced), so a format change in either tool shows up as a failing case.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib, { zstdCompressSync } from 'node:zlib';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { WorkStateSource } from '../../../src/services/work-view/data-source.mjs';
import { TRANSCRIPT_TAIL_BYTES, TurnStateReader } from '../../../src/services/work-view/turn-state-reader.mjs';
import { TURN_REASONS, closedTurn, turnStateFromTail } from '../../../src/services/work-view/turn-state.mjs';
import { HUMAN_NEEDS, WAITING_FOR, waitingForTurn } from '../../../src/services/work-view/waiting-for.mjs';

const SECRET = 'TRANSCRIPT-TEXT-THAT-MUST-NOT-LEAVE-THE-FILE';
const at = (seconds) => new Date(Date.UTC(2026, 10, 11, 12, 0, seconds)).toISOString();
const epoch = (seconds) => Date.UTC(2026, 10, 11, 12, 0, seconds);
const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

const claude = {
  prompt: (seconds, text = SECRET) => ({ parentUuid: null, isSidechain: false, promptId: 'p1', type: 'user', message: { role: 'user', content: text }, uuid: 'u1', timestamp: at(seconds), origin: { kind: 'human' }, sessionId: 's' }),
  assistant: (seconds, stopReason, content, extra = {}) => ({ parentUuid: 'u1', isSidechain: false, message: { model: 'claude-sonnet-5-5', id: 'msg_1', type: 'message', role: 'assistant', content, stop_reason: stopReason, stop_sequence: null }, type: 'assistant', uuid: 'a1', timestamp: at(seconds), sessionId: 's', ...extra }),
  text: (seconds, stopReason = 'end_turn') => claude.assistant(seconds, stopReason, [{ type: 'text', text: SECRET }]),
  thinking: (seconds, stopReason) => claude.assistant(seconds, stopReason, [{ type: 'thinking', thinking: SECRET, signature: 'sig' }]),
  toolUse: (seconds, name) => claude.assistant(seconds, 'tool_use', [{ type: 'tool_use', id: 'toolu_1', name, input: { command: SECRET } }]),
  toolResult: (seconds) => ({ parentUuid: 'a1', isSidechain: false, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: SECRET }] }, uuid: 'u2', timestamp: at(seconds), toolUseResult: { stdout: SECRET }, sessionId: 's' }),
  stopHooks: (seconds) => ({ parentUuid: 'a1', isSidechain: false, type: 'system', subtype: 'stop_hook_summary', hookCount: 4, preventedContinuation: false, timestamp: at(seconds), uuid: 'sys1', sessionId: 's' }),
  closing: () => [{ type: 'last-prompt', lastPrompt: SECRET, leafUuid: 'sys1', sessionId: 's' }, { type: 'cost-state', sessionId: 's' }],
};

const codex = {
  event: (seconds, type, extra = {}) => ({ timestamp: at(seconds), ordinal: seconds, type: 'event_msg', payload: { type, turn_id: 't1', ...extra } }),
  item: (seconds, payload) => ({ timestamp: at(seconds), ordinal: seconds, type: 'response_item', payload }),
  message: (seconds, role, extra = {}) => codex.item(seconds, { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: SECRET }], ...extra }),
  call: (seconds, name) => codex.item(seconds, { type: 'function_call', name, arguments: SECRET, call_id: 'call_1' }),
  exec: (seconds) => codex.item(seconds, { type: 'custom_tool_call', status: 'completed', call_id: 'call_2', name: 'exec', input: SECRET }),
  execOutput: (seconds) => codex.item(seconds, { type: 'custom_tool_call_output', call_id: 'call_2', output: SECRET }),
  tokens: (seconds) => [{ timestamp: at(seconds), type: 'token_usage_record', payload: { turn_id: 't1' } }, codex.event(seconds, 'token_count', { info: {} })],
  finished: (seconds) => [codex.message(seconds, 'assistant', { phase: 'final_answer' }), ...codex.tokens(seconds), codex.event(seconds, 'task_complete', { last_agent_message: SECRET, duration_ms: 5 })],
};

const read = (platform, records) => turnStateFromTail(platform, jsonl(records));

describe('a Claude Code transcript', () => {
  test('ending on a finished answer is the owner\'s move, timed at the answer and not at the bookkeeping after it', () => {
    const records = [claude.prompt(1), claude.thinking(5, 'end_turn'), claude.text(6), claude.stopHooks(7), ...claude.closing()];
    expect(read('claude', records)).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(6) });
    expect(read('claude', [claude.prompt(1), claude.text(6, 'stop_sequence')])).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(6) });
  });

  test('ending on an unanswered question tool waits on the owner\'s answer', () => {
    for (const tool of ['AskUserQuestion', 'ExitPlanMode']) {
      expect(read('claude', [claude.prompt(1), claude.thinking(4, 'tool_use'), claude.toolUse(5, tool)])).toEqual({ state: 'owner-turn', reason: 'question-pending', atEpoch: epoch(5) });
    }
  });

  test('ending on any other tool call, or on a tool\'s result, is the agent still working', () => {
    expect(read('claude', [claude.prompt(1), claude.toolUse(5, 'Bash')])).toEqual({ state: 'agent-turn', reason: 'tool-running', atEpoch: epoch(5) });
    expect(read('claude', [claude.prompt(1), claude.toolUse(5, 'Bash'), claude.toolResult(8)])).toEqual({ state: 'agent-turn', reason: 'tool-running', atEpoch: epoch(8) });
    expect(read('claude', [claude.toolUse(5, 'AskUserQuestion'), claude.toolResult(8), claude.thinking(9, 'tool_use')])).toEqual({ state: 'agent-turn', reason: 'tool-running', atEpoch: epoch(8) });
  });

  test('ending on the owner\'s prompt is the agent\'s move', () => {
    expect(read('claude', [claude.text(2), claude.stopHooks(3), ...claude.closing(), claude.prompt(9)])).toEqual({ state: 'agent-turn', reason: 'owner-spoke', atEpoch: epoch(9) });
    const skill = claude.prompt(9, '<command-message>review</command-message>\n<command-name>/review</command-name>');
    expect(read('claude', [claude.text(2), skill])?.reason).toBe('owner-spoke');
  });

  test('an interrupted turn hands the move back to the owner', () => {
    const interrupted = { ...claude.prompt(9), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } };
    expect(read('claude', [claude.prompt(1), claude.toolUse(5, 'Bash'), claude.toolResult(8), interrupted])).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(9) });
  });

  test('subagent records, injected context and local commands are not moves', () => {
    const sidechain = [{ ...claude.prompt(20), isSidechain: true }, { ...claude.toolUse(21, 'Bash'), isSidechain: true }, { ...claude.toolResult(22), isSidechain: true }];
    const injected = [{ ...claude.prompt(23, '<local-command-caveat>x</local-command-caveat>'), isMeta: true }, { ...claude.prompt(24), isCompactSummary: true }];
    const localCommand = [claude.prompt(25, '<command-name>/model</command-name>\n<command-message>model</command-message>'), claude.prompt(26, '<local-command-stdout>Set model</local-command-stdout>')];
    const shell = [claude.prompt(27, '<bash-input>ls</bash-input>'), claude.prompt(28, '<bash-stdout>files</bash-stdout><bash-stderr></bash-stderr>')];
    const records = [claude.prompt(1), claude.text(6), claude.stopHooks(7), ...sidechain, ...injected, ...localCommand, ...shell, ...claude.closing()];
    expect(read('claude', records)).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(6) });
  });
});

describe('a Codex rollout', () => {
  test('ending on task_complete is the owner\'s move', () => {
    const records = [codex.event(1, 'task_started'), codex.message(1, 'user'), codex.exec(3), codex.execOutput(4), ...codex.finished(9), codex.event(10, 'thread_settings_applied')];
    expect(read('codex', records)).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(9) });
  });

  test('a developer message appended after the turn ended does not reopen it', () => {
    const pushed = codex.message(40, 'developer', { internal_chat_message_metadata_passthrough: { turn_id: 'auto-compact-1' } });
    expect(read('codex', [codex.event(1, 'task_started'), ...codex.finished(9), pushed])).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(9) });
  });

  test('an aborted turn is the owner\'s move', () => {
    const records = [codex.event(1, 'task_started'), codex.message(1, 'user'), codex.message(2, 'developer'), codex.event(5, 'turn_aborted', { reason: 'interrupted' })];
    expect(read('codex', records)).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(5) });
  });

  test('a started turn is the agent\'s: on the prompt alone, on a tool call, or on its output', () => {
    const started = [...codex.finished(1), codex.event(5, 'task_started'), codex.message(5, 'user')];
    expect(read('codex', started)).toEqual({ state: 'agent-turn', reason: 'owner-spoke', atEpoch: epoch(5) });
    expect(read('codex', [...started, codex.exec(7)])).toEqual({ state: 'agent-turn', reason: 'tool-running', atEpoch: epoch(7) });
    expect(read('codex', [...started, codex.exec(7), codex.execOutput(8), codex.message(9, 'assistant'), ...codex.tokens(9)])).toEqual({ state: 'agent-turn', reason: 'tool-running', atEpoch: epoch(8) });
  });

  test('an unanswered request_user_input waits on the owner', () => {
    expect(read('codex', [codex.event(1, 'task_started'), codex.call(4, 'request_user_input')])).toEqual({ state: 'owner-turn', reason: 'question-pending', atEpoch: epoch(4) });
  });
});

describe('what a tail can and cannot say', () => {
  test('nothing decisive, an unknown tool or unreadable lines give no state rather than a guess', () => {
    expect(turnStateFromTail('claude', '')).toBeNull();
    expect(read('claude', [claude.stopHooks(1), ...claude.closing()])).toBeNull();
    expect(read('codex', [codex.message(1, 'developer'), ...codex.tokens(2)])).toBeNull();
    expect(read('windsurf', [claude.text(1)])).toBeNull();
    expect(read('constructor', [claude.text(1)])).toBeNull();
    expect(turnStateFromTail('claude', 'not json\n{"type":\n[1,2]\nnull\n')).toBeNull();
  });

  test('a first line cut by the read is skipped', () => {
    const tail = jsonl([claude.prompt(1), claude.text(6)]);
    expect(turnStateFromTail('claude', tail.slice(40))).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(6) });
  });

  test('every state is one of the listed reasons and carries no text', () => {
    const states = [read('claude', [claude.text(6)]), read('claude', [claude.toolUse(5, 'AskUserQuestion')]), read('claude', [claude.prompt(1)]), read('codex', [codex.exec(1)]), closedTurn(read('codex', codex.finished(9)))];
    expect(states.map((state) => state.reason).sort()).toEqual([...TURN_REASONS].sort());
    for (const state of states) expect(Object.keys(state).sort()).toEqual(['atEpoch', 'reason', 'state']);
    expect(JSON.stringify(states)).not.toContain(SECRET);
  });
});

describe('finding and reading the transcript on disk', () => {
  const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';
  // UUIDv7: its first 48 bits are 2026-10-31T02:36:52Z, which is 30 October in a US time zone.
  const CODEX_ID = '01a18fd1-234c-7000-8000-000000000004';
  let root, claudeProjectsDir, codexHome, reader;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'turn-state-'));
    claudeProjectsDir = join(root, 'claude', 'projects');
    codexHome = join(root, 'codex');
    mkdirSync(join(claudeProjectsDir, '-Users-someone-Proj-app'), { recursive: true });
    mkdirSync(join(claudeProjectsDir, '-Users-someone-Proj-other'), { recursive: true });
    mkdirSync(join(codexHome, 'sessions', '2026', '10', '30'), { recursive: true });
    mkdirSync(join(codexHome, 'archived_sessions'), { recursive: true });
    reader = new TurnStateReader({ claudeProjectsDir, codexHome });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const claudePath = () => join(claudeProjectsDir, '-Users-someone-Proj-other', `${CLAUDE_ID}.jsonl`);
  const rolloutName = `rollout-2026-10-30T19-36-50-${CODEX_ID}.jsonl`;

  test('reads a Claude transcript from whichever project folder holds it, and follows it as it grows', () => {
    writeFileSync(claudePath(), jsonl([claude.prompt(1), claude.toolUse(5, 'Bash')]));
    expect(reader.read('claude', CLAUDE_ID)).toEqual({ state: 'agent-turn', reason: 'tool-running', atEpoch: epoch(5) });
    appendFileSync(claudePath(), jsonl([claude.toolResult(8), claude.text(9), claude.stopHooks(10), ...claude.closing()]));
    expect(reader.read('claude', CLAUDE_ID)).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(9) });
  });

  test('reads only the end of a long transcript', () => {
    const early = Array.from({ length: 40 }, (_, index) => claude.prompt(index, 'x'.repeat(TRANSCRIPT_TAIL_BYTES / 16)));
    writeFileSync(claudePath(), jsonl([...early, claude.text(50), claude.stopHooks(51)]));
    expect(reader.read('claude', CLAUDE_ID)).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(50) });
    writeFileSync(claudePath(), jsonl([claude.text(50), claude.prompt(55, 'x'.repeat(TRANSCRIPT_TAIL_BYTES + 10))]));
    expect(reader.read('claude', CLAUDE_ID)).toBeNull();
  });

  test('finds a Codex rollout under its start day and compressed', () => {
    const body = jsonl([codex.event(1, 'task_started'), ...codex.finished(9)]);
    const live = join(codexHome, 'sessions', '2026', '10', '30', rolloutName);
    writeFileSync(live, body);
    const ended = { state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(9) };
    expect(reader.read('codex', CODEX_ID)).toEqual(ended);

    rmSync(live);
    writeFileSync(`${live}.zst`, zstdCompressSync(Buffer.from(body)));
    expect(reader.read('codex', CODEX_ID)).toBeNull();
    expect(new TurnStateReader({ claudeProjectsDir, codexHome }).read('codex', CODEX_ID)).toEqual(ended);
  });

  test('on a runtime without zstdDecompressSync a compressed rollout is skipped, plain transcripts still read, and an archived one is still closed', () => {
    const compressed = join(codexHome, 'sessions', '2026', '10', '30', `${rolloutName}.zst`);
    writeFileSync(compressed, zstdCompressSync(Buffer.from(jsonl(codex.finished(9)))));
    writeFileSync(claudePath(), jsonl([claude.prompt(1), claude.text(6)]));
    const { zstdDecompressSync } = zlib;
    // Node 20 and older Bun: the function is not on the module at all.
    delete zlib.zstdDecompressSync;
    try {
      expect(zlib.zstdDecompressSync).toBeUndefined();
      expect(reader.read('codex', CODEX_ID)).toBeNull();
      expect(reader.read('claude', CLAUDE_ID)).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(6) });
      renameSync(compressed, join(codexHome, 'archived_sessions', `${rolloutName}.zst`));
      expect(new TurnStateReader({ claudeProjectsDir, codexHome }).read('codex', CODEX_ID)).toMatchObject({ state: 'closed', reason: 'archived', atEpoch: expect.any(Number) });
    } finally {
      zlib.zstdDecompressSync = zstdDecompressSync;
    }
    expect(new TurnStateReader({ claudeProjectsDir, codexHome }).read('codex', CODEX_ID)).toEqual({ state: 'closed', reason: 'archived', atEpoch: epoch(9) });
  });

  describe('a Codex chat the owner archived', () => {
    const live = () => join(codexHome, 'sessions', '2026', '10', '30', rolloutName);
    const archived = () => join(codexHome, 'archived_sessions', rolloutName);
    const closed = (seconds) => ({ state: 'closed', reason: 'archived', atEpoch: epoch(seconds) });

    test('is closed, whichever move its rollout ended on, compressed or not', () => {
      writeFileSync(archived(), jsonl([codex.event(1, 'task_started'), ...codex.finished(9)]));
      expect(reader.read('codex', CODEX_ID)).toEqual(closed(9));
      writeFileSync(archived(), jsonl([codex.event(1, 'task_started'), codex.call(4, 'request_user_input')]));
      expect(reader.read('codex', CODEX_ID)).toEqual(closed(4));
      rmSync(archived());
      writeFileSync(`${archived()}.zst`, zstdCompressSync(Buffer.from(jsonl(codex.finished(9)))));
      expect(new TurnStateReader({ claudeProjectsDir, codexHome }).read('codex', CODEX_ID)).toEqual(closed(9));
    });

    test('is closed even when its rollout ends on nothing decisive, dated by the file', () => {
      writeFileSync(archived(), jsonl(codex.tokens(2)));
      expect(reader.read('codex', CODEX_ID)).toMatchObject({ state: 'closed', reason: 'archived', atEpoch: expect.any(Number) });
    });

    test('closes when a live rollout is archived, and is open again once it is taken out, with no stored flag', () => {
      const ended = { state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(9) };
      writeFileSync(live(), jsonl([codex.event(1, 'task_started'), ...codex.finished(9)]));
      expect(reader.read('codex', CODEX_ID)).toEqual(ended);
      renameSync(live(), archived());
      // The read that finds the file gone says nothing; the next one finds it in the archive.
      expect(reader.read('codex', CODEX_ID)).toBeNull();
      expect(reader.read('codex', CODEX_ID)).toEqual(closed(9));
      renameSync(archived(), live());
      expect(reader.read('codex', CODEX_ID)).toBeNull();
      expect(reader.read('codex', CODEX_ID)).toEqual(ended);
      appendFileSync(live(), jsonl([codex.event(20, 'task_started'), codex.exec(22)]));
      expect(reader.read('codex', CODEX_ID)).toEqual({ state: 'agent-turn', reason: 'tool-running', atEpoch: epoch(22) });
    });

    test('a copy still filed under its day is the chat, not the archived one', () => {
      writeFileSync(archived(), jsonl(codex.finished(9)));
      writeFileSync(live(), jsonl([...codex.finished(9), codex.event(20, 'task_started')]));
      expect(reader.read('codex', CODEX_ID)).toEqual({ state: 'agent-turn', reason: 'owner-spoke', atEpoch: epoch(20) });
    });

    test('Claude Code has no archive: its transcript is never closed', () => {
      writeFileSync(claudePath(), jsonl([claude.prompt(1), claude.text(6)]));
      expect(reader.read('claude', CLAUDE_ID).state).toBe('owner-turn');
    });
  });

  test('a fork\'s rollout, which names two sessions, is not the session\'s own', () => {
    writeFileSync(join(codexHome, 'sessions', '2026', '10', '30', `rollout-2026-10-30T19-40-00-${CODEX_ID}_01a18fd1-1edf-7000-8000-000000000003.jsonl`), jsonl(codex.finished(9)));
    expect(reader.read('codex', CODEX_ID)).toBeNull();
  });

  test('builds a path only from a UUID and a known tool', () => {
    writeFileSync(join(root, 'outside.jsonl'), jsonl([claude.text(6)]));
    writeFileSync(claudePath(), jsonl([claude.text(6)]));
    expect(reader.read('claude', '../../outside')).toBeNull();
    expect(reader.read('claude', `-Users-someone-Proj-other/${CLAUDE_ID}`)).toBeNull();
    expect(reader.read('windsurf', CLAUDE_ID)).toBeNull();
    expect(reader.readConversation('not json')).toBeNull();
    expect(reader.readConversation(JSON.stringify(['overall-request', 'claude', CLAUDE_ID]))).toBeNull();
    expect(reader.readConversation(JSON.stringify(['conversation', 'claude', CLAUDE_ID]))?.reason).toBe('turn-ended');
  });

  test('past its deadline it reads nothing new and keeps the last known state', () => {
    writeFileSync(claudePath(), jsonl([claude.prompt(1)]));
    expect(reader.read('claude', CLAUDE_ID, { deadline: 0 })).toBeNull();
    expect(reader.read('claude', CLAUDE_ID)?.reason).toBe('owner-spoke');
    appendFileSync(claudePath(), jsonl([claude.text(6)]));
    expect(reader.read('claude', CLAUDE_ID, { deadline: 0 })?.reason).toBe('owner-spoke');
    expect(reader.read('claude', CLAUDE_ID)?.reason).toBe('turn-ended');
  });

  describe('in a snapshot', () => {
    let store, source;
    beforeEach(() => {
      const databasePath = join(root, 'source.db');
      store = new SessionStore(databasePath, { syncOpsEnabled: false });
      for (const [id, platform] of [[CLAUDE_ID, 'claude'], [CODEX_ID, 'codex'], ['not-a-uuid', 'claude']]) {
        const session = store.createSDKSession(id, 'app', 'Please build the release cards for the launch', undefined, platform);
        store.saveUserPrompt(id, 1, 'Please build the release cards for the launch', session);
      }
      source = new WorkStateSource({ databasePath, ledgerDir: root, transcriptRoots: { claudeProjectsDir, codexHome } });
    });
    afterEach(() => { source.close(); store.close(); });

    const requests = () => source.read().agentView.humanRequests;
    const turnOf = (sessionId) => requests().find((request) => request.id.includes(sessionId))?.turn;

    test('each request carries its latest conversation\'s turn state, and nothing from the transcript but that', () => {
      writeFileSync(claudePath(), jsonl([claude.prompt(1), claude.text(6), claude.stopHooks(7), ...claude.closing()]));
      writeFileSync(join(codexHome, 'sessions', '2026', '10', '30', rolloutName), jsonl([codex.event(1, 'task_started'), codex.message(1, 'user'), codex.exec(3)]));
      const snapshot = source.read();
      expect(snapshot.agentView.humanRequests).toHaveLength(3);
      expect(turnOf(CLAUDE_ID)).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(6) });
      expect(turnOf(CODEX_ID)).toEqual({ state: 'agent-turn', reason: 'tool-running', atEpoch: epoch(3) });
      expect(requests().find((request) => request.id.includes('not-a-uuid'))).not.toHaveProperty('turn');
      expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    });

    test('a move changing hands is a new revision with no database write; an agent\'s progress through its turn is not', () => {
      writeFileSync(claudePath(), jsonl([claude.prompt(1), claude.toolUse(3, 'Bash')]));
      const working = source.read().agentView.revision;
      expect(source.read().agentView.revision).toBe(working);
      appendFileSync(claudePath(), jsonl([claude.toolResult(4), claude.toolUse(5, 'Read'), claude.toolResult(6)]));
      expect(source.read().agentView.revision).toBe(working);
      appendFileSync(claudePath(), jsonl([claude.text(9)]));
      const ended = source.read().agentView;
      expect(ended.revision).toBeGreaterThan(working);
      expect(ended.humanRequests.find((request) => request.id.includes(CLAUDE_ID)).turn.reason).toBe('turn-ended');
    });

    test('archiving a chat is a new revision and the request carries the closed state; taking it out is another', () => {
      const live = join(codexHome, 'sessions', '2026', '10', '30', rolloutName);
      writeFileSync(live, jsonl([codex.event(1, 'task_started'), ...codex.finished(9)]));
      const open = source.read().agentView;
      expect(turnOf(CODEX_ID).state).toBe('owner-turn');
      renameSync(live, join(codexHome, 'archived_sessions', rolloutName));
      source.read();
      const closed = source.read().agentView;
      expect(closed.humanRequests.find((request) => request.id.includes(CODEX_ID)).turn).toEqual({ state: 'closed', reason: 'archived', atEpoch: epoch(9) });
      expect(closed.revision).toBeGreaterThan(open.revision);
      renameSync(join(codexHome, 'archived_sessions', rolloutName), live);
      source.read();
      const reopened = source.read().agentView;
      expect(reopened.humanRequests.find((request) => request.id.includes(CODEX_ID)).turn.state).toBe('owner-turn');
      expect(reopened.revision).toBeGreaterThan(closed.revision);
    });

    describe('what an ended turn waits for, from its session summary', () => {
      const summarize = (waitingFor, seconds) => store.storeObservations('memory-claude', 'app',
        [], { request: 'Build the release cards', investigated: '', learned: '', completed: 'Built them', next_steps: '', notes: null, waiting_for: waitingFor }, 1, 0, epoch(seconds));
      const promptedAt = (seconds) => store.db.run('UPDATE user_prompts SET created_at_epoch = ? WHERE content_session_id = ?', [epoch(seconds), CLAUDE_ID]);
      beforeEach(() => {
        store.updateMemorySessionId(store.db.query('SELECT id FROM sdk_sessions WHERE content_session_id = ?').get(CLAUDE_ID).id, 'memory-claude');
        promptedAt(1);
        writeFileSync(claudePath(), jsonl([claude.prompt(1), claude.text(6), claude.stopHooks(7), ...claude.closing()]));
      });

      test('the summary written as the turn ended names it, and its arrival is a new revision', () => {
        const before = source.read().agentView;
        expect(turnOf(CLAUDE_ID)).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(6) });
        summarize('approval', 8);
        const after = source.read().agentView;
        expect(turnOf(CLAUDE_ID)).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(6), waitingFor: 'approval' });
        expect(after.revision).toBeGreaterThan(before.revision);
        summarize('nothing', 9);
        expect(turnOf(CLAUDE_ID).waitingFor).toBe('nothing');
        expect(source.read().agentView.revision).toBeGreaterThan(after.revision);
      });

      test('a summary that did not say, or of a turn before this one, adds nothing', () => {
        summarize(null, 8);
        expect(turnOf(CLAUDE_ID)).not.toHaveProperty('waitingFor');
        summarize('review', 8);
        appendFileSync(claudePath(), jsonl([claude.prompt(20), claude.text(26)]));
        promptedAt(20);
        expect(turnOf(CLAUDE_ID)).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(26) });
      });

      test('a summary older than the owner\'s last prompt is ignored, however close to the turn\'s end', () => {
        summarize('answer', 4);
        expect(turnOf(CLAUDE_ID).waitingFor).toBe('answer');
        promptedAt(5);
        expect(turnOf(CLAUDE_ID)).not.toHaveProperty('waitingFor');
      });

      test('only an ended turn is asked, and a database without the column reads as before', () => {
        summarize('review', 8);
        appendFileSync(claudePath(), jsonl([claude.toolUse(9, 'AskUserQuestion')]));
        expect(turnOf(CLAUDE_ID)).toEqual({ state: 'owner-turn', reason: 'question-pending', atEpoch: epoch(9) });
        writeFileSync(claudePath(), jsonl([claude.prompt(1), claude.text(6)]));
        expect(turnOf(CLAUDE_ID).waitingFor).toBe('review');
        store.db.run('ALTER TABLE session_summaries DROP COLUMN waiting_for');
        source.close();
        expect(turnOf(CLAUDE_ID)).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(6) });
      });
    });

    describe('what an ended Codex turn waits for', () => {
      const STOP_HOOK_LEAD_MS = 30;
      const summarize = (waitingFor, createdAtEpoch) => store.storeObservations('memory-codex', 'app',
        [], { request: 'Build the release cards', investigated: '', learned: '', completed: 'Built them', next_steps: '', notes: null, waiting_for: waitingFor }, 1, 0, createdAtEpoch);
      const promptedAt = (seconds) => store.db.run('UPDATE user_prompts SET created_at_epoch = ? WHERE content_session_id = ?', [epoch(seconds), CODEX_ID]);
      const rolloutPath = () => join(codexHome, 'sessions', '2026', '10', '30', rolloutName);
      beforeEach(() => {
        promptedAt(1);
        writeFileSync(rolloutPath(), jsonl([codex.event(1, 'task_started'), codex.message(1, 'user'), codex.exec(3), codex.execOutput(4), ...codex.finished(6)]));
      });

      test('with no summary, as when no Codex hook reached the worker, the turn says only that it ended', () => {
        expect(turnOf(CODEX_ID)).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(6) });
      });

      test('the summary the Stop hook asked for, stored milliseconds before task_complete, names each thing a turn can wait for', () => {
        store.updateMemorySessionId(store.db.query('SELECT id FROM sdk_sessions WHERE content_session_id = ?').get(CODEX_ID).id, 'memory-codex');
        for (const word of WAITING_FOR) {
          summarize(word, epoch(6) - STOP_HOOK_LEAD_MS);
          expect(turnOf(CODEX_ID)).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(6), waitingFor: word });
        }
      });

      test('a summary of the turn before the owner\'s last prompt says nothing about this one', () => {
        store.updateMemorySessionId(store.db.query('SELECT id FROM sdk_sessions WHERE content_session_id = ?').get(CODEX_ID).id, 'memory-codex');
        summarize('approval', epoch(6) - STOP_HOOK_LEAD_MS);
        appendFileSync(rolloutPath(), jsonl([codex.event(20, 'task_started'), codex.message(20, 'user'), ...codex.finished(26)]));
        promptedAt(20);
        expect(turnOf(CODEX_ID)).toEqual({ state: 'owner-turn', reason: 'turn-ended', atEpoch: epoch(26) });
      });
    });
  });
});

describe('whether a summary was written for the turn that just ended', () => {
  const END = epoch(100);
  const summary = (seconds, waitingFor = 'review') => ({ waitingFor, createdAtEpoch: epoch(seconds) });
  const waits = (input) => waitingForTurn({ turnEndedAtEpoch: END, lastOwnerPromptEpoch: epoch(40), ...input });

  test('a summary stored as the turn ended counts: seconds after it (Claude) or milliseconds before it (Codex)', () => {
    expect(waits({ summary: summary(103) })).toBe('review');
    expect(waits({ summary: { waitingFor: 'answer', createdAtEpoch: END - 47 } })).toBe('answer');
    expect(waits({ summary: summary(96) })).toBe('review');
  });

  test('a summary of an earlier stop still counts while the owner has not written again: the agent was woken and ended its turn without a new one', () => {
    expect(waits({ summary: summary(94) })).toBe('review');
    expect(waits({ summary: summary(50, 'answer') })).toBe('answer');
  });

  test('with no recorded prompt time, a summary of an earlier stop does not count', () => {
    expect(waits({ summary: summary(94), lastOwnerPromptEpoch: null })).toBeNull();
  });

  test('a summary older than the owner\'s last prompt does not, and an unrecorded prompt time leaves the turn end to decide', () => {
    expect(waits({ summary: summary(97), lastOwnerPromptEpoch: epoch(98) })).toBeNull();
    expect(waits({ summary: summary(97), lastOwnerPromptEpoch: epoch(97) })).toBe('review');
    expect(waits({ summary: summary(97), lastOwnerPromptEpoch: null })).toBe('review');
  });

  test('nothing is told without a known value, a summary time or a turn time', () => {
    expect(waits({ summary: null })).toBeNull();
    expect(waits({ summary: summary(103, null) })).toBeNull();
    expect(waits({ summary: summary(103, 'merge') })).toBeNull();
    expect(waits({ summary: { waitingFor: 'review', createdAtEpoch: null } })).toBeNull();
    expect(waits({ summary: summary(103), turnEndedAtEpoch: null })).toBeNull();
  });

  test('a person can owe everything a turn can wait for except nothing', () => {
    expect(WAITING_FOR).toEqual([...HUMAN_NEEDS, 'nothing']);
  });
});
