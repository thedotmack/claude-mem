import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  addExcludeMark,
  appendMiddleCacheRecordsAtomic,
  assertSafeMiddleCachePath,
  buildCcsAlignRecord,
  buildExcludeSet,
  ccsAlignCursorPath,
  ccsAlignExcludeMarksPath,
  ccsAlignLineBody,
  ccsAlignMiddleCachePath,
  formatCcsAlignLine,
  isOriginalCacheWritable,
  landObservationsInMiddleCache,
  observationMatchesCcsAlignNeedle,
  readCursor,
  readExcludeMarks,
  readMiddleCache,
  rebuildMiddleCache,
  removeExcludeMark,
  writeCursor,
  writeExcludeMarks,
  type CcsAlignObservationInput,
  type ExcludeMarksFile,
} from '../../src/services/integrations/CcsAlignMiddleCache.js';

const VIEWER = 'ccs-align';
const now = new Date('2026-09-09T15:04:05.000Z');

function makeObs(overrides: Partial<CcsAlignObservationInput> = {}): CcsAlignObservationInput {
  return {
    id: 12345,
    type: 'decision',
    title: 'Land the middle cache',
    subtitle: 'Phase 0 only',
    facts: ['Write dated fact lines into the seat-owned middle cache'],
    created_at: '2026-09-09T00:00:00.000Z',
    project: 'claude-mem',
    agent_id: null,
    source: 'worker',
    ...overrides,
  };
}

describe('CCS Align middle cache', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'ccs-align-'));
    temps.push(dir);
    return dir;
  }

  it('formats a dated fact line tagged [ccs-align] and truncates to 500 chars', () => {
    const short = formatCcsAlignLine(makeObs(), now);
    expect(short).toBe(
      '- 2026-09-09 [ccs-align] decision — Land the middle cache: Phase 0 only. Write dated fact lines into the seat-owned middle cache',
    );

    const long = formatCcsAlignLine(makeObs({
      title: 'x'.repeat(600),
      subtitle: '',
      facts: [],
    }), now);
    expect(long.startsWith('- 2026-09-09 [ccs-align] decision — ')).toBe(true);
    expect(long.length).toBe(500);
    expect(long.endsWith('…')).toBe(true);
  });

  it('matches needle types or concepts and rejects empty filters', () => {
    expect(observationMatchesCcsAlignNeedle({ type: 'decision' }, ['decision'], [])).toBe(true);
    expect(observationMatchesCcsAlignNeedle({ type: 'discovery' }, ['decision'], [])).toBe(false);
    expect(observationMatchesCcsAlignNeedle({ type: 'discovery', concepts: ['gotcha'] }, [], ['gotcha'])).toBe(true);
    expect(observationMatchesCcsAlignNeedle({ type: 'decision' }, [], [])).toBe(false);
  });

  it('lands a record into the seat-owned middle.jsonl and never touches profile.md', () => {
    const root = tempRoot();
    const { appended, cachePath } = landObservationsInMiddleCache({
      viewerId: VIEWER,
      observations: [makeObs()],
      dataRoot: root,
      now,
    });

    expect(appended).toHaveLength(1);
    expect(cachePath).toBe(path.join(root, 'ccs-align', VIEWER, 'middle.jsonl'));

    const records = readMiddleCache(cachePath);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(12345);
    expect(records[0].v).toBe(1);
    expect(records[0].source).toBe('worker');
    expect(records[0].line.includes('[ccs-align]')).toBe(true);

    // Never a second [awareness] writer, never profile.md, never agents/**/memory/log.
    expect(existsSync(path.join(root, 'ccs-align', VIEWER, 'profile.md'))).toBe(false);
    expect(existsSync(path.join(root, 'agents'))).toBe(false);
  });

  it('dedupes by observation id and body so the same fact is not landed twice', () => {
    const root = tempRoot();
    const first = landObservationsInMiddleCache({ viewerId: VIEWER, observations: [makeObs()], dataRoot: root, now });
    expect(first.appended).toHaveLength(1);

    // Same observation on a later day: date differs but body dedupe still skips.
    const second = landObservationsInMiddleCache({
      viewerId: VIEWER,
      observations: [makeObs()],
      dataRoot: root,
      now: new Date('2026-09-10T00:00:00.000Z'),
    });
    expect(second.appended).toHaveLength(0);

    const records = readMiddleCache(first.cachePath);
    expect(records).toHaveLength(1);
  });

  it('appends new observations onto an existing cache without rewriting earlier lines', () => {
    const root = tempRoot();
    const cachePath = ccsAlignMiddleCachePath(root, VIEWER);

    const r1 = appendMiddleCacheRecordsAtomic(cachePath, [buildCcsAlignRecord(makeObs({ id: 1 }), now)]);
    expect(r1.appended).toHaveLength(1);
    const r2 = appendMiddleCacheRecordsAtomic(cachePath, [buildCcsAlignRecord(makeObs({ id: 2, title: 'second' }), now)]);
    expect(r2.appended).toHaveLength(1);
    // Re-appending id 1 is a no-op that must not rewrite/grow the file.
    const r3 = appendMiddleCacheRecordsAtomic(cachePath, [buildCcsAlignRecord(makeObs({ id: 1 }), now)]);
    expect(r3.appended).toHaveLength(0);

    const lines = readFileSync(cachePath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]) as { id: number }).id).toBe(1);
    expect((JSON.parse(lines[1]) as { id: number }).id).toBe(2);
  });

  it('refuses writes to profile.md, agents/**/memory/log, and outside the seat root', () => {
    const root = tempRoot();
    expect(() => assertSafeMiddleCachePath(root, VIEWER, ccsAlignMiddleCachePath(root, VIEWER))).not.toThrow();
    expect(() => assertSafeMiddleCachePath(root, VIEWER, path.join(root, 'ccs-align', VIEWER, 'profile.md'))).toThrow();
    expect(() => assertSafeMiddleCachePath(root, VIEWER, path.join(root, 'agents', 'x', 'memory', 'log', '2026-09.md'))).toThrow();
    expect(() => assertSafeMiddleCachePath(root, VIEWER, path.join(root, 'somewhere-else', 'middle.jsonl'))).toThrow();
  });

  it('never throws into the caller when the write path is broken', () => {
    const root = tempRoot();
    // Make the middle.jsonl target a directory so the atomic rename fails.
    const cachePath = ccsAlignMiddleCachePath(root, VIEWER);
    mkdirSync(cachePath, { recursive: true });

    expect(() => landObservationsInMiddleCache({
      viewerId: VIEWER,
      observations: [makeObs()],
      dataRoot: root,
      now,
    })).not.toThrow();
  });

  it('treats a missing original laminate path as append-only (D2): never invents one', () => {
    const root = tempRoot();
    const missing = path.join(root, 'nope', 'laminate.jsonl');
    expect(isOriginalCacheWritable(missing)).toBe(false);
    expect(isOriginalCacheWritable(null)).toBe(false);

    const { appended, cachePath } = landObservationsInMiddleCache({
      viewerId: VIEWER,
      observations: [makeObs()],
      dataRoot: root,
      now,
      originalCachePath: missing,
    });
    // Still lands in the seat file; the laminate path is not created.
    expect(appended).toHaveLength(1);
    expect(existsSync(cachePath)).toBe(true);
    expect(existsSync(missing)).toBe(false);
  });

  it('round-trips the cursor file at the seat path', () => {
    const root = tempRoot();
    const cursorPath = ccsAlignCursorPath(root, VIEWER);
    expect(readCursor(cursorPath)).toBeNull();

    writeCursor(cursorPath, {
      lastRunAt: now.toISOString(),
      lastObservationId: 12345,
      healthPath: '/api/health',
      workerPort: 37700,
    });

    const cursor = readCursor(cursorPath);
    expect(cursor?.lastObservationId).toBe(12345);
    expect(cursor?.healthPath).toBe('/api/health');
    expect(cursor?.workerPort).toBe(37700);
  });

  it('dedupe body key excludes the date so line bodies compare stably', () => {
    const a = formatCcsAlignLine(makeObs(), new Date('2026-09-09T00:00:00.000Z'));
    const b = formatCcsAlignLine(makeObs(), new Date('2026-12-25T00:00:00.000Z'));
    expect(a).not.toBe(b);
    expect(ccsAlignLineBody(a)).toBe(ccsAlignLineBody(b));
    expect(ccsAlignLineBody(a).startsWith('[ccs-align] decision')).toBe(true);
  });

  // --- Phase 1: Exclude marks ---

  it('marks an observation as excluded and drops it from the compiled middle cache', () => {
    const root = tempRoot();
    landObservationsInMiddleCache({
      viewerId: VIEWER,
      observations: [makeObs({ id: 100 }), makeObs({ id: 200, title: 'keeper' })],
      dataRoot: root,
      now,
    });

    let records = readMiddleCache(ccsAlignMiddleCachePath(root, VIEWER));
    expect(records).toHaveLength(2);

    const marksPath = ccsAlignExcludeMarksPath(root, VIEWER);
    addExcludeMark(marksPath, 100, [], 'manual');

    const result = landObservationsInMiddleCache({
      viewerId: VIEWER,
      observations: [],
      dataRoot: root,
      now,
    });
    expect(result.dropped).toBe(1);

    records = readMiddleCache(ccsAlignMiddleCachePath(root, VIEWER));
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(200);
  });

  it('the diary still has the marked observation (SQLite is authoritative, not the compiled cache)', () => {
    const root = tempRoot();
    landObservationsInMiddleCache({
      viewerId: VIEWER,
      observations: [makeObs({ id: 100 }), makeObs({ id: 200, title: 'keeper' })],
      dataRoot: root,
      now,
    });

    const marksPath = ccsAlignExcludeMarksPath(root, VIEWER);
    addExcludeMark(marksPath, 100, ['toolu_01abc'], 'manual');

    landObservationsInMiddleCache({
      viewerId: VIEWER,
      observations: [],
      dataRoot: root,
      now,
    });

    const marks = readExcludeMarks(marksPath);
    expect(marks.marks).toHaveLength(1);
    expect(marks.marks[0].observationId).toBe(100);
    expect(marks.marks[0].toolUseIds).toEqual(['toolu_01abc']);

    const records = readMiddleCache(ccsAlignMiddleCachePath(root, VIEWER));
    expect(records.every(r => r.id !== 100)).toBe(true);
  });

  it('tool-use ids on a mark never appear in middle.jsonl (layer 4 stays out of the laminate)', () => {
    const root = tempRoot();
    landObservationsInMiddleCache({
      viewerId: VIEWER,
      observations: [makeObs({ id: 300 })],
      dataRoot: root,
      now,
    });

    const marksPath = ccsAlignExcludeMarksPath(root, VIEWER);
    addExcludeMark(marksPath, 300, ['toolu_01xyz', 999], 'stripper');

    landObservationsInMiddleCache({
      viewerId: VIEWER,
      observations: [],
      dataRoot: root,
      now,
    });

    const raw = readFileSync(ccsAlignMiddleCachePath(root, VIEWER), 'utf8');
    expect(raw).not.toContain('toolu_01xyz');
    expect(raw).not.toContain('"300"');
    expect(raw).not.toContain('"id":300');
  });

  it('viewer B cache does not contain viewer A unique eval token (viewer isolation)', () => {
    const root = tempRoot();
    const viewerA = 'viewer-a';
    const viewerB = 'viewer-b';
    const evalToken = `EVAL_TOKEN_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    landObservationsInMiddleCache({
      viewerId: viewerA,
      observations: [makeObs({ id: 1, title: evalToken })],
      dataRoot: root,
      now,
    });

    landObservationsInMiddleCache({
      viewerId: viewerB,
      observations: [makeObs({ id: 2, title: 'viewer B fact' })],
      dataRoot: root,
      now,
    });

    const cacheA = readFileSync(ccsAlignMiddleCachePath(root, viewerA), 'utf8');
    const cacheB = readFileSync(ccsAlignMiddleCachePath(root, viewerB), 'utf8');
    expect(cacheA).toContain(evalToken);
    expect(cacheB).not.toContain(evalToken);
  });

  it('unmark + rebuild restores the observation on the next pull', () => {
    const root = tempRoot();
    const allObs = [
      makeObs({ id: 100 }),
      makeObs({ id: 200, title: 'keeper' }),
    ];

    landObservationsInMiddleCache({
      viewerId: VIEWER,
      observations: allObs,
      dataRoot: root,
      now,
    });
    expect(readMiddleCache(ccsAlignMiddleCachePath(root, VIEWER))).toHaveLength(2);

    const marksPath = ccsAlignExcludeMarksPath(root, VIEWER);
    addExcludeMark(marksPath, 100, [], 'manual');

    landObservationsInMiddleCache({
      viewerId: VIEWER,
      observations: [],
      dataRoot: root,
      now,
    });
    expect(readMiddleCache(ccsAlignMiddleCachePath(root, VIEWER))).toHaveLength(1);

    removeExcludeMark(marksPath, 100);
    expect(readExcludeMarks(marksPath).marks).toHaveLength(0);

    rebuildMiddleCache({
      viewerId: VIEWER,
      observations: allObs,
      dataRoot: root,
      now,
    });

    const rebuilt = readMiddleCache(ccsAlignMiddleCachePath(root, VIEWER));
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt.some(r => r.id === 100)).toBe(true);
    expect(rebuilt.some(r => r.id === 200)).toBe(true);
  });

  it('round-trips exclude-marks.json and is idempotent per observationId', () => {
    const root = tempRoot();
    const marksPath = ccsAlignExcludeMarksPath(root, VIEWER);

    expect(readExcludeMarks(marksPath)).toEqual({ v: 1, marks: [] });

    addExcludeMark(marksPath, 42, ['toolu_01abc'], 'manual', 'ccs-align', now);
    addExcludeMark(marksPath, 42, ['toolu_01abc'], 'manual', 'ccs-align', now);

    const marks = readExcludeMarks(marksPath);
    expect(marks.v).toBe(1);
    expect(marks.marks).toHaveLength(1);
    expect(marks.marks[0].observationId).toBe(42);
    expect(marks.marks[0].toolUseIds).toEqual(['toolu_01abc']);
    expect(marks.marks[0].reason).toBe('manual');
    expect(marks.marks[0].markedBy).toBe('ccs-align');
    expect(marks.marks[0].markedAt).toBe(now.toISOString());
  });

  it('writeExcludeMarks round-trips the full schema', () => {
    const root = tempRoot();
    const marksPath = ccsAlignExcludeMarksPath(root, VIEWER);
    const data: ExcludeMarksFile = {
      v: 1,
      marks: [
        { observationId: 1, toolUseIds: ['toolu_x', 2], reason: 'sibling-wall', markedAt: now.toISOString(), markedBy: 'ccs-align' },
        { observationId: 2, toolUseIds: [], reason: 'secure-isolation', markedAt: now.toISOString(), markedBy: 'test' },
      ],
    };
    writeExcludeMarks(marksPath, data);

    const read = readExcludeMarks(marksPath);
    expect(read).toEqual(data);
  });

  it('buildExcludeSet correctly aggregates observation and tool-use ids', () => {
    const { excludedObsIds, excludedToolUseIds } = buildExcludeSet([
      { observationId: 1, toolUseIds: ['a', 2], reason: 'manual', markedAt: '', markedBy: '' },
      { observationId: 3, toolUseIds: ['b'], reason: 'stripper', markedAt: '', markedBy: '' },
    ]);
    expect(excludedObsIds.has(1)).toBe(true);
    expect(excludedObsIds.has(3)).toBe(true);
    expect(excludedObsIds.has(99)).toBe(false);
    expect(excludedToolUseIds.has('a')).toBe(true);
    expect(excludedToolUseIds.has(2)).toBe(true);
    expect(excludedToolUseIds.has('b')).toBe(true);
  });

  it('marks with reason "secure-isolation" are honored the same as manual', () => {
    const root = tempRoot();
    landObservationsInMiddleCache({
      viewerId: VIEWER,
      observations: [makeObs({ id: 500 })],
      dataRoot: root,
      now,
    });

    const marksPath = ccsAlignExcludeMarksPath(root, VIEWER);
    addExcludeMark(marksPath, 500, [], 'secure-isolation');

    landObservationsInMiddleCache({
      viewerId: VIEWER,
      observations: [],
      dataRoot: root,
      now,
    });

    const records = readMiddleCache(ccsAlignMiddleCachePath(root, VIEWER));
    expect(records.every(r => r.id !== 500)).toBe(true);
  });

  it('a corrupt exclude-marks.json is treated as empty (fail-closed)', () => {
    const root = tempRoot();
    const marksPath = ccsAlignExcludeMarksPath(root, VIEWER);
    const dir = path.dirname(marksPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(marksPath, 'NOT VALID JSON{{{', 'utf8');

    const marks = readExcludeMarks(marksPath);
    expect(marks).toEqual({ v: 1, marks: [] });
  });

  it('new records with a marked id are never appended (skip on ingest)', () => {
    const root = tempRoot();
    const marksPath = ccsAlignExcludeMarksPath(root, VIEWER);
    addExcludeMark(marksPath, 999, [], 'manual');

    const result = landObservationsInMiddleCache({
      viewerId: VIEWER,
      observations: [makeObs({ id: 999 }), makeObs({ id: 1000, title: 'not excluded' })],
      dataRoot: root,
      now,
    });

    expect(result.appended).toHaveLength(1);
    expect(result.appended[0].id).toBe(1000);

    const records = readMiddleCache(ccsAlignMiddleCachePath(root, VIEWER));
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(1000);
  });
});
