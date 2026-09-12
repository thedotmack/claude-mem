import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ParsedObservation } from '../../src/sdk/parser.js';
import {
  GROK_BOT_AWARENESS_PILOT_AGENT_IDS,
  appendAwarenessLineAtomic,
  awarenessLineBody,
  formatAwarenessLine,
  grokBotAwarenessLogPath,
  notifyGrokBotAwareness,
  observationMatchesAwarenessNeedle,
  type GrokBotAwarenessPushConfig,
} from '../../src/services/integrations/GrokBotAwarenessPusher.js';

const LFG = GROK_BOT_AWARENESS_PILOT_AGENT_IDS[0];
const ORIFICE = GROK_BOT_AWARENESS_PILOT_AGENT_IDS[1];
const OTHER_AGENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const now = new Date('2026-09-09T15:04:05.000Z');

function makeObs(overrides: Partial<ParsedObservation> = {}): ParsedObservation {
  return {
    type: 'decision',
    title: 'Ship the awareness pusher',
    subtitle: 'Phase 1 only',
    facts: ['Write dated fact lines into the agent memory log'],
    narrative: 'Pilot agents re-read disk mid-epoch.',
    concepts: ['pattern'],
    files_read: [],
    files_modified: [],
    ...overrides,
  };
}

function makeConfig(root: string, overrides: Partial<GrokBotAwarenessPushConfig> = {}): GrokBotAwarenessPushConfig {
  return {
    enabled: true,
    agentIds: [LFG, ORIFICE],
    triggerTypes: ['decision', 'bugfix', 'security_alert', 'sensitive'],
    triggerConcepts: [],
    agentDataRoot: root,
    now,
    ...overrides,
  };
}

describe('Grok Bot awareness pusher', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'awareness-push-'));
    temps.push(dir);
    return dir;
  }

  it('formats a dated fact line tagged [awareness] and truncates to 500 chars', () => {
    const short = formatAwarenessLine(makeObs(), now);
    expect(short).toBe(
      '- 2026-09-09 [awareness] decision — Ship the awareness pusher: Phase 1 only. Write dated fact lines into the agent memory log',
    );

    const long = formatAwarenessLine(makeObs({
      title: 'x'.repeat(600),
      subtitle: '',
      facts: [],
    }), now);
    expect(long.startsWith('- 2026-09-09 [awareness] decision — ')).toBe(true);
    expect(long.length).toBe(500);
    expect(long.endsWith('…')).toBe(true);
  });

  it('matches needle types or concepts and rejects empty filters', () => {
    expect(observationMatchesAwarenessNeedle(makeObs(), ['decision'], [])).toBe(true);
    expect(observationMatchesAwarenessNeedle(makeObs({ type: 'discovery' }), ['decision'], [])).toBe(false);
    expect(observationMatchesAwarenessNeedle(makeObs({ type: 'discovery', concepts: ['gotcha'] }), [], ['gotcha'])).toBe(true);
    expect(observationMatchesAwarenessNeedle(makeObs(), [], [])).toBe(false);
  });

  it('appends one fact line for a pilot agent and skips non-needles', async () => {
    const root = tempRoot();
    await notifyGrokBotAwareness({
      observations: [
        makeObs({ type: 'discovery', title: 'noise' }),
        makeObs(),
      ],
      observationIds: [10, 11],
      project: 'cmem_work_lfg',
      memorySessionId: 'mem-1',
      agentId: LFG,
    }, makeConfig(root));

    const logPath = grokBotAwarenessLogPath(root, LFG, now);
    const body = readFileSync(logPath, 'utf8');
    expect(body).toBe(
      '- 2026-09-09 [awareness] decision — Ship the awareness pusher: Phase 1 only. Write dated fact lines into the agent memory log\n',
    );
    expect(existsSync(path.join(root, 'agents', LFG, 'profile.md'))).toBe(false);
    expect(existsSync(path.join(root, 'agents', LFG, 'memory', 'profile.md'))).toBe(false);
  });

  it('does not write when agent_id is missing, invalid, or outside the pilot allowlist', async () => {
    const root = tempRoot();
    const cases: Array<string | null | undefined> = [null, undefined, '', '*', 'not-a-uuid', OTHER_AGENT];
    for (const agentId of cases) {
      await notifyGrokBotAwareness({
        observations: [makeObs()],
        observationIds: [1],
        project: 'cmem_work_lfg',
        memorySessionId: 'mem-1',
        agentId,
      }, makeConfig(root));
    }
    expect(existsSync(path.join(root, 'agents'))).toBe(false);
  });

  it('is a no-op when disabled or when both trigger lists are empty', async () => {
    const root = tempRoot();
    await notifyGrokBotAwareness({
      observations: [makeObs()],
      observationIds: [1],
      project: 'cmem_work_orifice',
      memorySessionId: 'mem-1',
      agentId: ORIFICE,
    }, makeConfig(root, { enabled: false }));
    await notifyGrokBotAwareness({
      observations: [makeObs()],
      observationIds: [1],
      project: 'cmem_work_orifice',
      memorySessionId: 'mem-1',
      agentId: ORIFICE,
    }, makeConfig(root, { triggerTypes: [], triggerConcepts: [] }));
    expect(existsSync(path.join(root, 'agents'))).toBe(false);
  });

  it('dedupes by awareness body so the same fact is not appended twice', async () => {
    const root = tempRoot();
    const input = {
      observations: [makeObs()],
      observationIds: [1],
      project: 'cmem_work_lfg',
      memorySessionId: 'mem-1',
      agentId: LFG,
    };
    await notifyGrokBotAwareness(input, makeConfig(root));
    await notifyGrokBotAwareness(input, makeConfig(root, { now: new Date('2026-09-10T00:00:00.000Z') }));

    const logPath = grokBotAwarenessLogPath(root, LFG, now);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(awarenessLineBody(lines[0]).startsWith('[awareness] decision')).toBe(true);
  });

  it('atomically appends onto an existing monthly log without rewriting earlier lines', () => {
    const root = tempRoot();
    const logPath = grokBotAwarenessLogPath(root, LFG, now);
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, '- 2026-09-01 [awareness] bugfix — prior fact\n', 'utf8');

    expect(appendAwarenessLineAtomic(logPath, formatAwarenessLine(makeObs(), now))).toBe(true);
    expect(appendAwarenessLineAtomic(logPath, formatAwarenessLine(makeObs(), now))).toBe(false);

    const body = readFileSync(logPath, 'utf8');
    expect(body.startsWith('- 2026-09-01 [awareness] bugfix — prior fact\n')).toBe(true);
    expect(body.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('never throws into the caller when the write path is broken', async () => {
    const root = tempRoot();
    const blocked = path.join(root, 'agents', LFG, 'memory', 'log');
    mkdirSync(path.dirname(blocked), { recursive: true });
    writeFileSync(blocked, 'i-am-a-file-not-a-dir', 'utf8');

    await expect(notifyGrokBotAwareness({
      observations: [makeObs()],
      observationIds: [1],
      project: 'cmem_work_lfg',
      memorySessionId: 'mem-1',
      agentId: LFG,
    }, makeConfig(root))).resolves.toBeUndefined();
  });
});
