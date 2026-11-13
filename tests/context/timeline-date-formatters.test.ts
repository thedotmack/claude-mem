import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createTimelineDateFormatters, formatDate, formatDateTime, formatTime, groupByDate,
} from '../../src/shared/timeline-formatting.js';
import { buildHumanTimelineEntries, renderAgentTimeline } from '../../src/services/context/sections/TimelineRenderer.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import type { ContextConfig, TimelineItem } from '../../src/services/context/types.js';

const dates = [
  '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z',
  '2026-11-01T05:59:00Z', '2026-11-01T06:00:00Z',
  '2026-11-13T00:00:00Z', '2026-11-13T12:00:00Z', 0,
];

let priorMode: unknown;
let priorModeId: unknown;
beforeEach(() => {
  const mode = ModeManager.getInstance();
  priorMode = Reflect.get(mode, 'activeMode');
  priorModeId = Reflect.get(mode, 'activeModeId');
});
afterEach(() => {
  const mode = ModeManager.getInstance();
  Reflect.set(mode, 'activeMode', priorMode);
  Reflect.set(mode, 'activeModeId', priorModeId);
});

function inZone<T>(zone: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { return run(); }
  finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

const config: ContextConfig = {
  totalObservationCount: 50, fullObservationCount: 0, sessionCount: 3,
  showReadTokens: false, showWorkTokens: false, observationTypes: new Set(['discovery']),
  observationConcepts: new Set(), fullObservationField: 'narrative',
  showLastSummary: false, showLastMessage: false, mainAgentOnly: false,
};
const timestamp = '2026-11-13T01:34:00Z';
const timeline: TimelineItem[] = [{ type: 'observation', data: {
  id: 1, memory_session_id: 'formatter-test', type: 'discovery', title: 'Saved memory',
  subtitle: null, narrative: null, facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]',
  discovery_tokens: 0, created_at: timestamp, created_at_epoch: Date.parse(timestamp),
} }, { type: 'summary', data: {
  id: 2, memory_session_id: 'formatter-test', request: 'Session summary', investigated: null,
  learned: null, completed: null, next_steps: null, created_at: timestamp,
  created_at_epoch: Date.parse(timestamp), displayEpoch: Date.parse(timestamp), displayTime: timestamp,
  shouldShowLink: false,
} }];

describe('timeline locale formatting', () => {
  for (const zone of ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Kolkata', 'Pacific/Apia']) {
    it(`preserves the native locale output and day groups in ${zone}`, () => inZone(zone, () => {
      const cached = createTimelineDateFormatters();
      for (const input of dates) {
        expect(cached.formatDate(input)).toBe(formatDate(input));
        expect(cached.formatTime(input)).toBe(formatTime(input));
        expect(cached.formatDateTime(input)).toBe(formatDateTime(input));
      }
      const rows = dates.map((date, id) => ({ id, date: new Date(date).toISOString() }));
      const nativeGroups = new Map<string, typeof rows>();
      for (const row of rows) {
        const key = formatDate(row.date);
        const group = nativeGroups.get(key) ?? [];
        group.push(row);
        nativeGroups.set(key, group);
      }
      expect([...groupByDate(rows, row => row.date, { order: 'first-seen' })]).toEqual([...nativeGroups]);
    }));
  }

  it('keeps invalid dates as Invalid Date in every output shape', () => {
    const cached = createTimelineDateFormatters();
    for (const input of ['not a date', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(cached.formatDate(input)).toBe('Invalid Date');
      expect(cached.formatTime(input)).toBe('Invalid Date');
      expect(cached.formatDateTime(input)).toBe('Invalid Date');
    }
  });

  it('observes a changed default time zone on the next actual timeline render', () => {
    // Other suites replace process.env with a plain object. In Bun, later TZ
    // assignments then no longer update ICU's default zone. Use a fresh process
    // while keeping both renders in that same process to test cache lifetime.
    const result = Bun.spawnSync([process.execPath, '-e', `
      import { formatDate, formatTime } from './src/shared/timeline-formatting.ts';
      import { renderAgentTimeline } from './src/services/context/sections/TimelineRenderer.ts';
      import { ModeManager } from './src/services/domain/ModeManager.ts';
      ModeManager.getInstance().loadMode('code');
      const timeline = ${JSON.stringify(timeline)};
      const config = {
        ...${JSON.stringify(config)},
        observationTypes: new Set(['discovery']), observationConcepts: new Set(),
      };
      const render = zone => {
        process.env.TZ = zone;
        return {
          lines: renderAgentTimeline(timeline, new Set(), config).join('\\n'),
          day: formatDate(${JSON.stringify(timestamp)}), time: formatTime(${JSON.stringify(timestamp)}),
        };
      };
      console.log(JSON.stringify({ utc: render('UTC'), pacific: render('America/Los_Angeles') }));
    `], { cwd: process.cwd(), env: { ...process.env, TZ: 'UTC' } });
    expect(result.exitCode).toBe(0);
    const { utc, pacific } = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(utc.lines).toContain(utc.day);
    expect(utc.lines).toContain(utc.time);
    expect(pacific.lines).toContain(pacific.day);
    expect(pacific.lines).toContain(pacific.time);
    expect(pacific.day).not.toBe(utc.day);
    expect(pacific.lines).not.toBe(utc.lines);
  });

  it('keeps agent and terminal memory usable when ICU initialization fails', () => {
    ModeManager.getInstance().loadMode('code');
    const Native = Intl.DateTimeFormat;
    Intl.DateTimeFormat = new Proxy(Native, { construct() { throw new TypeError('failed to initialize DateTimeFormat'); } });
    try {
      const lines = renderAgentTimeline(timeline, new Set(), config).join('\n');
      const entries = buildHumanTimelineEntries(timeline, new Set(), config, '/fixture');
      expect(lines).toContain('2026-11-13');
      expect(lines).toContain('1:34 AM');
      expect(lines).toContain('Saved memory');
      expect(entries).toHaveLength(2);
      expect(entries.every(entry => entry.day === '2026-11-13')).toBe(true);
      expect(entries.flatMap(entry => entry.lines).join('\n')).toContain('Session summary');
    } finally { Intl.DateTimeFormat = Native; }
  });

  it('recovers after a transient formatter initialization failure', () => inZone('America/New_York', () => {
    const expected = formatDate(timestamp);
    const Native = Intl.DateTimeFormat;
    const cached = createTimelineDateFormatters();
    Intl.DateTimeFormat = new Proxy(Native, { construct() { throw new TypeError('temporary ICU failure'); } });
    try { expect(cached.formatDate(timestamp)).toBe('2026-11-13'); }
    finally { Intl.DateTimeFormat = Native; }
    expect(cached.formatDate(timestamp)).toBe(expected);
    expect(expected).not.toBe('2026-11-13');
  }));
});
