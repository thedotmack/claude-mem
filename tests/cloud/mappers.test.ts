import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { storeObservations } from '../../src/services/sqlite/transactions.js';
import { saveUserPrompt } from '../../src/services/sqlite/prompts/store.js';
import { createSDKSession, updateMemorySessionId } from '../../src/services/sqlite/Sessions.js';
import { __setCloudEnabledForTest } from '../../src/services/cloud/config.js';
import {
  parseJsonArray,
  readObservationPayloads,
  readSummaryPayloads,
  readPromptPayloads,
} from '../../src/services/cloud/mappers.js';

describe('parseJsonArray', () => {
  it('parses a JSON array string into a string[]', () => {
    expect(parseJsonArray('["a","b"]')).toEqual(['a', 'b']);
  });
  it('returns [] for null/empty/garbage', () => {
    expect(parseJsonArray(null)).toEqual([]);
    expect(parseJsonArray('')).toEqual([]);
    expect(parseJsonArray('not json')).toEqual([]);
    expect(parseJsonArray('{"a":1}')).toEqual([]);
  });
  it('passes through an already-array value', () => {
    expect(parseJsonArray(['x', 'y'])).toEqual(['x', 'y']);
  });
});

describe('row -> payload mapping', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    __setCloudEnabledForTest(true);
  });
  afterEach(() => {
    __setCloudEnabledForTest(null);
    db.close();
  });

  function seed(content: string, memory: string, project = 'proj-a'): string {
    const dbId = createSDKSession(db, content, project, 'initial');
    updateMemorySessionId(db, dbId, memory);
    return memory;
  }

  it('maps an observation row to the camelCase payload, parsing JSON arrays', () => {
    const memoryId = seed('c1', 'm1');
    const result = storeObservations(db, memoryId, 'proj-a', [
      {
        type: 'discovery',
        title: 'T',
        subtitle: 'S',
        facts: ['f1', 'f2'],
        narrative: 'N',
        concepts: ['c1', 'c2'],
        files_read: ['/a.ts'],
        files_modified: ['/b.ts'],
      },
    ]);
    const id = result.observationIds[0];
    const [payload] = readObservationPayloads(db, [id]);
    expect(payload.localId).toBe(id);
    expect(payload.memorySessionId).toBe('m1');
    expect(payload.project).toBe('proj-a');
    expect(payload.type).toBe('discovery');
    expect(payload.title).toBe('T');
    expect(payload.subtitle).toBe('S');
    expect(payload.facts).toEqual(['f1', 'f2']);
    expect(payload.concepts).toEqual(['c1', 'c2']);
    expect(payload.filesRead).toEqual(['/a.ts']);
    expect(payload.filesModified).toEqual(['/b.ts']);
    expect(payload.narrative).toBe('N');
    expect(typeof payload.createdAtEpoch).toBe('number');
  });

  it('maps a summary row to the camelCase payload (nextSteps from next_steps)', () => {
    const memoryId = seed('c2', 'm2');
    const result = storeObservations(db, memoryId, 'proj-a', [
      { type: 'discovery', title: 'x', subtitle: null, facts: [], narrative: null, concepts: [], files_read: [], files_modified: [] },
    ], {
      request: 'req', investigated: 'inv', learned: 'lrn', completed: 'cmp', next_steps: 'nxt', notes: 'note',
    });
    const [payload] = readSummaryPayloads(db, [result.summaryId!]);
    expect(payload.localId).toBe(result.summaryId);
    expect(payload.memorySessionId).toBe('m2');
    expect(payload.request).toBe('req');
    expect(payload.investigated).toBe('inv');
    expect(payload.learned).toBe('lrn');
    expect(payload.completed).toBe('cmp');
    expect(payload.nextSteps).toBe('nxt');
    expect(payload.notes).toBe('note');
  });

  it('maps a prompt row, deriving project + memorySessionId via sdk_sessions join', () => {
    seed('content-xyz', 'mem-xyz', 'proj-b');
    const id = saveUserPrompt(db, 'content-xyz', 1, 'hello world');
    const [payload] = readPromptPayloads(db, [id]);
    expect(payload.localId).toBe(id);
    expect(payload.contentSessionId).toBe('content-xyz');
    expect(payload.promptText).toBe('hello world');
    expect(payload.promptNumber).toBe(1);
    // Derived from the join:
    expect(payload.project).toBe('proj-b');
    expect(payload.memorySessionId).toBe('mem-xyz');
  });

  it('prompt before memory_session_id is resolved yields null memorySessionId but a project', () => {
    // A session can exist (FK satisfied) before its memory_session_id is set.
    createSDKSession(db, 'pending-session', 'proj-c', 'initial');
    const id = saveUserPrompt(db, 'pending-session', 1, 'early prompt');
    const [payload] = readPromptPayloads(db, [id]);
    expect(payload.contentSessionId).toBe('pending-session');
    expect(payload.project).toBe('proj-c');
    expect(payload.memorySessionId).toBeNull();
  });
});
