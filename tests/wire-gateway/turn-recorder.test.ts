import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import {
  RECORDED_DIRECTION_BUDGET_BYTES,
  WireTurnRecorder,
  boundRecorderParts,
  recordedSessionFolderName,
  type WireGatewayTurn,
  type WireRecordingConsent,
} from '../../src/services/wire-gateway/capture/turn-recorder.js';

const recordingsDirectory = join(WIRE_GATEWAY_DIR, 'turn-recorder-test-recordings');
const DAY_MS = 24 * 60 * 60 * 1000;

function switchableConsent(): WireRecordingConsent & { on: boolean; generation: number } {
  const consent = {
    on: true,
    generation: 1,
    isRecordingOn: () => consent.on,
    recordingGeneration: () => consent.generation,
  };
  return consent;
}

function turnAt(time: string, fields: Partial<WireGatewayTurn> = {}): WireGatewayTurn {
  return {
    agent: 'codex',
    session: 'thread-1',
    time,
    model: 'gpt-6',
    status: 200,
    input: [{ role: 'user', kind: 'text', text: 'list the files' }],
    output: [{ role: 'assistant', kind: 'text', text: 'Two files.' }],
    routeId: 'codex',
    kind: 'turn',
    ...fields,
  };
}

function turnsFileOf(time: string, agent = 'codex', session = 'thread-1'): string {
  return join(recordingsDirectory, time.slice(0, 10), recordedSessionFolderName(agent, session), 'turns.jsonl');
}

let recorder: WireTurnRecorder | null = null;

beforeEach(() => rmSync(recordingsDirectory, { recursive: true, force: true }));
afterEach(() => {
  recorder?.dispose();
  recorder = null;
  rmSync(recordingsDirectory, { recursive: true, force: true });
});

describe('WireTurnRecorder', () => {
  it('writes nothing while recording is off (no consent yet)', () => {
    recorder = new WireTurnRecorder({ retentionDays: 7, recordingsDirectory, cleanupIntervalMs: 0 });
    const now = new Date().toISOString();
    expect(recorder.save(turnAt(now), recorder.currentGeneration())).toBe('recording_off');
    expect(existsSync(recordingsDirectory)).toBe(false);
  });

  it('appends one line per turn under <UTC date>/<sha256(JSON([agent, session]))>/turns.jsonl, owner-only', () => {
    const consent = switchableConsent();
    recorder = new WireTurnRecorder({ consent, retentionDays: 7, recordingsDirectory, cleanupIntervalMs: 0 });
    const now = new Date().toISOString();
    expect(recorder.save(turnAt(now), 1)).toBe('saved');
    expect(recorder.save(turnAt(now, { output: [{ role: 'assistant', kind: 'text', text: 'Again.' }] }), 1)).toBe('saved');
    const turnsFile = turnsFileOf(now);
    const lines = readFileSync(turnsFile, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ agent: 'codex', session: 'thread-1', model: 'gpt-6', status: 200, routeId: 'codex', kind: 'turn' });
    expect(lines[1].output[0].text).toBe('Again.');
    expect(recordedSessionFolderName('codex', 'thread-1')).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') {
      expect(statSync(turnsFile).mode & 0o777).toBe(0o600);
      expect(statSync(join(turnsFile, '..')).mode & 0o777).toBe(0o700);
    }
  });

  it('a consent generation bump during an in-flight request means it is not saved', () => {
    const consent = switchableConsent();
    recorder = new WireTurnRecorder({ consent, retentionDays: 7, recordingsDirectory, cleanupIntervalMs: 0 });
    const generationAtStart = recorder.currentGeneration();
    consent.generation++; // recording was cleared and turned back on while the request was in flight
    expect(recorder.save(turnAt(new Date().toISOString()), generationAtStart)).toBe('generation_changed');
    expect(existsSync(recordingsDirectory)).toBe(false);
  });

  it('repairs a half-written final line before appending', () => {
    const consent = switchableConsent();
    recorder = new WireTurnRecorder({ consent, retentionDays: 7, recordingsDirectory, cleanupIntervalMs: 0 });
    const now = new Date().toISOString();
    recorder.save(turnAt(now), 1);
    appendFileSync(turnsFileOf(now), '{"agent":"codex","sess');
    recorder.save(turnAt(now), 1);
    const lines = readFileSync(turnsFileOf(now), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('bounds each direction to 64 KiB and each part on a UTF-8 boundary, counting what was cut', () => {
    const longText = '界'.repeat(30_000); // 90,000 bytes
    const { parts, cut } = boundRecorderParts([
      { role: 'user', kind: 'text', text: longText },
      { role: 'user', kind: 'text', text: 'never reached' },
    ]);
    expect(cut).toBe(true);
    expect(parts).toHaveLength(1);
    expect(Buffer.byteLength(parts[0].text, 'utf8')).toBeLessThanOrEqual(RECORDED_DIRECTION_BUDGET_BYTES);
    expect(parts[0].text.length + parts[0].cut!).toBe(30_000);
    expect(parts[0].text.endsWith('界')).toBe(true);

    const untouched = boundRecorderParts([{ role: 'user', kind: 'text', text: 'short' }]);
    expect(untouched).toEqual({ parts: [{ role: 'user', kind: 'text', text: 'short' }], cut: false });
  });

  it('cleanup removes days past retention and keeps the rest', () => {
    const consent = switchableConsent();
    const now = Date.now();
    recorder = new WireTurnRecorder({ consent, retentionDays: 7, recordingsDirectory, cleanupIntervalMs: 0, now: () => now });
    const today = new Date(now).toISOString();
    recorder.save(turnAt(today), 1);
    const oldDay = new Date(now - 9 * DAY_MS).toISOString().slice(0, 10);
    const oldFile = join(recordingsDirectory, oldDay, recordedSessionFolderName('codex', 'old'), 'turns.jsonl');
    mkdirSync(join(oldFile, '..'), { recursive: true });
    writeFileSync(oldFile, '{}\n');
    utimesSync(oldFile, new Date(now - 9 * DAY_MS), new Date(now - 9 * DAY_MS));

    recorder.pruneRecordings();
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(join(recordingsDirectory, oldDay))).toBe(false);
    expect(existsSync(turnsFileOf(today))).toBe(true);
  });
});
