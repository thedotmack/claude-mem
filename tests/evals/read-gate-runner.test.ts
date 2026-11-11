import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  armSettings,
  hookMatcherSelectsTool,
  lineAnchorFailures,
  parseRunnerArguments,
  seededLineAnchorRows,
  showsLineAnchorOutput,
  synchronousReadHookProblem,
  type SeedObservation,
} from '../../scripts/eval-read-gate.js';
import {
  LINE_ANCHOR_CHANGED_FILE_NOTE,
  LINE_ANCHOR_CONTEXT_HINT,
  LINE_ANCHOR_DENY_HINT,
  LINE_ANCHOR_ROW_SUFFIX,
  LINE_ANCHORS_METADATA_KEY,
  readLineAnchors,
  type LineAnchorState,
} from '../../src/shared/line-anchors.js';

const repoRoot = join(import.meta.dir, '..', '..');
const readJson = (relativePath: string): unknown => JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8'));

describe('requireSynchronousReadHook', () => {
  it('reads a matcher the way Claude Code does: every tool, exact names, or a regular expression', () => {
    const cases: Array<[string | undefined, boolean]> = [
      [undefined, true],
      ['', true],
      ['*', true],
      ['Read', true],
      ['Edit|Read', true],
      ['Read|^read_file$|^Bash$|^Grep$', true],
      ['Rea', false],
      ['ReadFile', false],
      ['Edit|Write', false],
      ['^Bash$|^Grep$', false],
      ['(', false],
    ];
    for (const [matcher, selectsRead] of cases) {
      expect([matcher, hookMatcherSelectsTool(matcher, 'Read')]).toEqual([matcher, selectsRead]);
    }
  });

  it('finds the plugin\'s own PreToolUse Read hook, whose matcher is a regular expression, and finds it synchronous', () => {
    expect(synchronousReadHookProblem(readJson('plugin/hooks/hooks.json'))).toBeNull();
  });

  it('names an async Read hook and a missing one', () => {
    const withHook = (matcher: string, isAsync: boolean) => ({
      hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: 'claude-mem', ...(isAsync ? { async: true } : {}) }] }] },
    });
    expect(synchronousReadHookProblem(withHook('Read|^read_file$', true))).toContain('"async": true');
    expect(synchronousReadHookProblem(withHook('^Bash$', false))).toBe('plugin/hooks/hooks.json has no PreToolUse hook for Read');
    expect(synchronousReadHookProblem({})).toBe('plugin/hooks/hooks.json has no PreToolUse hook for Read');
  });
});

describe('--line-anchors', () => {
  const arm = { port: 40123, gateEnabled: true, dataDirectory: '/eval/on/data' };

  it('is off unless asked for', () => {
    expect(parseRunnerArguments([]).lineAnchors).toBe(false);
    expect(parseRunnerArguments(['--preflight-only', '--line-anchors'])).toMatchObject({ preflightOnly: true, lineAnchors: true });
  });

  it('turns the setting on in both arms, and leaves a default run\'s settings as they were', () => {
    expect(armSettings(arm)).not.toHaveProperty('CLAUDE_MEM_LINE_ANCHORS_ENABLED');
    // Either way an eval worker never starts My Work's scheduled agent run on the real HOME.
    expect(armSettings(arm)).toMatchObject({ CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH: 'false' });
    expect(armSettings(arm, true)).toMatchObject({ CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH: 'false' });
    expect(armSettings(arm, true)).toMatchObject({ CLAUDE_MEM_LINE_ANCHORS_ENABLED: 'true', CLAUDE_MEM_FILE_READ_GATE_ENABLED: 'true' });
    expect(armSettings({ ...arm, gateEnabled: false }, true)).toMatchObject({
      CLAUDE_MEM_LINE_ANCHORS_ENABLED: 'true', CLAUDE_MEM_FILE_READ_GATE_ENABLED: 'false',
    });
  });

  it('seeds line anchors only on the large fixture\'s declaration lines, never on a graded number', () => {
    const seeds = readJson('tests/evals/read-gate/seed-observations.json') as SeedObservation[];
    const fixtureLines = readFileSync(join(repoRoot, 'tests/evals/read-gate/fixture-large/src/shipping/carrier-tariffs.ts'), 'utf8').split('\n');
    const anchored = seeds.filter(seed => seed.metadata !== undefined);

    expect(anchored.map(seed => Object.keys(seed.metadata!))).toEqual([[LINE_ANCHORS_METADATA_KEY], [LINE_ANCHORS_METADATA_KEY]]);
    const anchors = anchored.flatMap(seed => readLineAnchors(JSON.stringify(seed.metadata)));
    expect(anchors.map(anchor => [anchor.path, anchor.line])).toEqual([
      ['src/shipping/carrier-tariffs.ts', 908],
      ['src/shipping/carrier-tariffs.ts', 523],
    ]);
    const squashed = (line: string) => line.replace(/\s+/g, ' ').trim();
    for (const anchor of anchors) {
      expect(fixtureLines[anchor.line - 1]).toBe(anchor.text);
      // Unique by exact and by whitespace-squashed text, as the worker requires of a line it anchors.
      expect(fixtureLines.filter(line => line === anchor.text)).toHaveLength(1);
      expect(fixtureLines.filter(line => squashed(line) === squashed(anchor.text))).toHaveLength(1);
      expect(anchor.text).toMatch(/^export function (quoteCarrierRate|calculateLithiumBatterySurcharge)\(/);
      expect(anchor.text).not.toMatch(/\d/);
    }
  });

  it('expects each anchored seed\'s row to end with its line, and no line anchors at all where none may show', () => {
    const seeds = readJson('tests/evals/read-gate/seed-observations.json') as SeedObservation[];
    const seeded = seeds.map((seed, index) => ({ id: 101 + index, title: seed.title, createdAtEpoch: 0 }));
    const rows = seededLineAnchorRows(seeds, seeded);
    expect([...rows]).toEqual([[105, ' @L908'], [106, ' @L523']]);

    const shown = '105 9:30a 🔵 quoteCarrierRate prices a shipment @L908\n106 10:30a 🟣 Lithium battery handling surcharge @L523';
    expect(lineAnchorFailures(shown, true, rows)).toEqual([]);
    expect(lineAnchorFailures('105 9:30a 🔵 quoteCarrierRate prices a shipment', true, rows)).toHaveLength(2);
    expect(lineAnchorFailures(shown, false, rows)).toEqual([
      'shows line anchors (an @L or "(code changed since)" row ending, or a line direction) where none may show',
    ]);
    expect(lineAnchorFailures('105 9:30a 🔵 quoteCarrierRate prices a shipment', false, rows)).toEqual([]);
    expect(lineAnchorFailures(shown, true, new Map())).toHaveLength(1);
  });

  it('counts timeline rows and the hook\'s line directions as line anchors, never a path that holds "@L"', () => {
    const atLabs = '/home/dev/@Labs/claude-mem/.scratch/read-gate-eval/run/on/preflight/home/cwd/src/shipping/carrier-tariffs.ts';
    const denyReason = [
      `Full-file Read blocked by claude-mem: ${atLabs} has prior observations (listed below). Get what you need without reading the whole file:`,
      `- Current code: call smart_outline(file_path="${atLabs}") for its symbols and line numbers`,
      '105 9:30a 🔵 quoteCarrierRate prices a shipment',
    ].join('\n');
    expect(showsLineAnchorOutput(denyReason)).toBe(false);
    expect(lineAnchorFailures(denyReason, false, new Map())).toEqual([]);

    // Every way the hook shows line anchors, in the hook's own words: each state's row ending, one and two lines, and each direction.
    const states = Object.keys(LINE_ANCHOR_ROW_SUFFIX) as LineAnchorState[];
    expect(states).toHaveLength(3);
    for (const line of [
      ...states.flatMap(state => [[908], [121, 908]].map(lines => `105 9:30a 🔵 quoteCarrierRate prices a shipment${LINE_ANCHOR_ROW_SUFFIX[state](lines)}`)),
      LINE_ANCHOR_CONTEXT_HINT,
      LINE_ANCHOR_DENY_HINT,
      LINE_ANCHOR_CHANGED_FILE_NOTE,
    ]) {
      expect([line, showsLineAnchorOutput(`${denyReason}\n${line}`)]).toEqual([line, true]);
    }
  });
});
