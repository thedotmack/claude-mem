import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import net from 'net';
import {
  analyzeReadGateTrace,
  CASE_GATE_OFF_ANSWERS,
  CASE_GATE_ON_ANSWERS,
  CASE_GATE_ON_EDITS,
  countLines,
  decideVerdicts,
  GET_OBSERVATIONS_TOOL,
  isWholeFileRead,
  processesStillUsingArm,
  READ_GATE_DENY_MARKER,
  SMART_OUTLINE_TOOL,
  SMART_UNFOLD_TOOL,
  type ReadGateTraceAnalysis,
  type RunEvidence,
} from '../../scripts/eval-read-gate.js';

const FIXTURE = 'src/shipping/rate-calculator.ts';
const ABSOLUTE_FIXTURE = `/eval-sandbox/e-AbC123/home/cwd/${FIXTURE}`;
const TOTAL_LINES = 513;
const OPTIONS = { fixtureRelativePath: FIXTURE, fixtureTotalLines: TOTAL_LINES };
const DENY_TEXT = `PreToolUse:Read hook error: Current: 2026-10-05 4:12pm PDT\n${READ_GATE_DENY_MARKER}: ${ABSOLUTE_FIXTURE} has prior observations (listed below).`;

function toolUse(id: string, name: string, input: Record<string, unknown>): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
}

function toolResult(id: string, content: unknown, isError = false): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
  });
}

describe('analyzeReadGateTrace', () => {
  it('counts a denied whole-file Read, the smart tools, and the targeted Read that followed', () => {
    const analysis = analyzeReadGateTrace([
      JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read'] }),
      toolUse('toolu_read_whole', 'Read', { file_path: ABSOLUTE_FIXTURE }),
      toolResult('toolu_read_whole', DENY_TEXT, true),
      toolUse('toolu_outline', SMART_OUTLINE_TOOL, { file_path: ABSOLUTE_FIXTURE }),
      toolResult('toolu_outline', [{ type: 'text', text: 'calculateRemoteAreaSurcharge L299-306' }]),
      toolUse('toolu_unfold', SMART_UNFOLD_TOOL, { file_path: ABSOLUTE_FIXTURE, symbol_name: 'calculateRemoteAreaSurcharge' }),
      toolResult('toolu_unfold', [{ type: 'text', text: 'export function calculateRemoteAreaSurcharge(...)' }]),
      toolUse('toolu_observations', GET_OBSERVATIONS_TOOL, { ids: [2] }),
      toolResult('toolu_observations', [{ type: 'text', text: '#2 Remote-area surcharge applies a percentage' }]),
      toolUse('toolu_read_window', 'Read', { file_path: ABSOLUTE_FIXTURE, offset: 296, limit: 15 }),
      toolResult('toolu_read_window', '296\t * Remote-area surcharge ...'),
      JSON.stringify({ type: 'result', subtype: 'success', num_turns: 6, total_cost_usd: 0.12 }),
    ], OPTIONS);

    expect(analysis).toEqual({
      wholeFileReadAttempts: 1,
      wholeFileReadsDenied: 1,
      wholeFileReadsSucceeded: 0,
      targetedReads: 1,
      targetedReadsSucceeded: 1,
      targetedReadsDenied: 0,
      smartOutlineCalls: 1,
      smartUnfoldCalls: 1,
      getObservationsCalls: 1,
      denyMarkerAppeared: true,
      unparsableLines: 0,
    });
  });

  it('counts a whole-file Read that returned the file as succeeded, relative path included', () => {
    const analysis = analyzeReadGateTrace([
      toolUse('toolu_1', 'Read', { file_path: FIXTURE }),
      toolResult('toolu_1', '1\t/**\n2\t * Parcel shipping rate calculator.'),
    ], OPTIONS);

    expect(analysis.wholeFileReadAttempts).toBe(1);
    expect(analysis.wholeFileReadsSucceeded).toBe(1);
    expect(analysis.wholeFileReadsDenied).toBe(0);
    expect(analysis.denyMarkerAppeared).toBe(false);
  });

  it('reads a deny delivered as text blocks', () => {
    const analysis = analyzeReadGateTrace([
      toolUse('toolu_1', 'Read', { file_path: ABSOLUTE_FIXTURE, offset: 1, limit: 2000 }),
      toolResult('toolu_1', [{ type: 'text', text: DENY_TEXT }], true),
    ], OPTIONS);

    expect(analysis.wholeFileReadAttempts).toBe(1);
    expect(analysis.wholeFileReadsDenied).toBe(1);
  });

  it('flags a denied targeted Read, which would block Edit', () => {
    const analysis = analyzeReadGateTrace([
      toolUse('toolu_1', 'Read', { file_path: ABSOLUTE_FIXTURE, offset: 40, limit: 20 }),
      toolResult('toolu_1', DENY_TEXT, true),
    ], OPTIONS);

    expect(analysis.targetedReads).toBe(1);
    expect(analysis.targetedReadsDenied).toBe(1);
    expect(analysis.targetedReadsSucceeded).toBe(0);
    expect(analysis.wholeFileReadAttempts).toBe(0);
  });

  it('ignores other files, and does not count an error without the marker as a deny', () => {
    const analysis = analyzeReadGateTrace([
      toolUse('toolu_other', 'Read', { file_path: '/eval-sandbox/e-AbC123/home/cwd/src/shipping/index.ts' }),
      toolResult('toolu_other', '1\texport * from "./rate-calculator";'),
      toolUse('toolu_failed', 'Read', { file_path: ABSOLUTE_FIXTURE }),
      toolResult('toolu_failed', 'File content exceeds maximum allowed tokens', true),
    ], OPTIONS);

    expect(analysis.wholeFileReadAttempts).toBe(1);
    expect(analysis.wholeFileReadsDenied).toBe(0);
    expect(analysis.wholeFileReadsSucceeded).toBe(0);
    expect(analysis.targetedReads).toBe(0);
  });

  it('counts a Read without a result as an attempt only', () => {
    const analysis = analyzeReadGateTrace([toolUse('toolu_1', 'Read', { file_path: ABSOLUTE_FIXTURE })], OPTIONS);

    expect(analysis.wholeFileReadAttempts).toBe(1);
    expect(analysis.wholeFileReadsDenied).toBe(0);
    expect(analysis.wholeFileReadsSucceeded).toBe(0);
  });

  it('counts a cut-off line instead of throwing', () => {
    const analysis = analyzeReadGateTrace(['{"type":"assistant","message":{"content":[', ''], OPTIONS);

    expect(analysis.unparsableLines).toBe(1);
    expect(analysis.wholeFileReadAttempts).toBe(0);
  });
});

describe('isWholeFileRead', () => {
  it('is true when the window starts at line 1 and reaches the last line', () => {
    expect(isWholeFileRead({}, TOTAL_LINES)).toBe(true);
    expect(isWholeFileRead({ offset: 0 }, TOTAL_LINES)).toBe(true);
    expect(isWholeFileRead({ offset: 1, limit: TOTAL_LINES }, TOTAL_LINES)).toBe(true);
    expect(isWholeFileRead({ limit: 2000 }, TOTAL_LINES)).toBe(true);
  });

  it('counts a malformed offset or limit as absent, as the gate does', () => {
    expect(isWholeFileRead({ offset: 'start', limit: null }, TOTAL_LINES)).toBe(true);
    expect(isWholeFileRead({ offset: -3, limit: 20 }, TOTAL_LINES)).toBe(false);
  });

  it('is false for a window that skips the start or stops before the end', () => {
    expect(isWholeFileRead({ offset: 2 }, TOTAL_LINES)).toBe(false);
    expect(isWholeFileRead({ limit: TOTAL_LINES - 1 }, TOTAL_LINES)).toBe(false);
    expect(isWholeFileRead({ offset: '40', limit: '20' }, TOTAL_LINES)).toBe(false);
  });
});

describe('countLines', () => {
  it('counts lines with or without a trailing newline', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
  });
});

describe('decideVerdicts', () => {
  const noActivity: ReadGateTraceAnalysis = analyzeReadGateTrace([], OPTIONS);

  function run(caseName: string, runNumber: number, graders: Record<string, boolean>, analysis: Partial<ReadGateTraceAnalysis>): RunEvidence {
    return {
      caseName, runNumber, graders,
      score: null, turns: 5, costUsd: 0.1, error: null, tracePath: null,
      analysis: { ...noActivity, ...analysis },
    };
  }

  const blocked = { wholeFileReadAttempts: 1, wholeFileReadsDenied: 1, targetedReads: 1, targetedReadsSucceeded: 1, denyMarkerAppeared: true };
  const answered = { 'read-blocked': true, 'answer-rate': true, 'answer-minimum': true };
  const edited = { 'read-blocked': true, edited: true, 'old-value-gone': true };
  const readNormally = { wholeFileReadAttempts: 1, wholeFileReadsSucceeded: 1 };
  const answeredOff = { 'not-blocked': true, 'read-used': true, 'answer-rate': true, 'answer-minimum': true };

  it('passes every verdict when the gate blocks, Claude still answers and edits, and gate off reads normally', () => {
    const verdicts = decideVerdicts([
      ...[1, 2, 3].map(number => run(CASE_GATE_ON_ANSWERS, number, answered, blocked)),
      ...[1, 2, 3].map(number => run(CASE_GATE_ON_EDITS, number, edited, number === 3 ? {} : blocked)),
      ...[1, 2, 3].map(number => run(CASE_GATE_OFF_ANSWERS, number, answeredOff, readNormally)),
    ]);

    expect(verdicts.map(item => [item.id, item.status])).toEqual([
      ['gate-on-deny-exercised', 'pass'],
      ['gate-on-no-whole-file-read', 'pass'],
      ['gate-on-attempts-denied', 'pass'],
      ['gate-on-answers', 'pass'],
      ['gate-on-edits', 'pass'],
      ['gate-off-never-denied', 'pass'],
      ['gate-off-reads-succeed', 'pass'],
      ['gate-off-answers', 'pass'],
    ]);
  });

  it('fails when a gated run read the whole file, gate off showed the marker, or too few answers passed', () => {
    const verdicts = decideVerdicts([
      run(CASE_GATE_ON_ANSWERS, 1, answered, { wholeFileReadAttempts: 1, wholeFileReadsSucceeded: 1 }),
      run(CASE_GATE_ON_ANSWERS, 2, { ...answered, 'answer-rate': false }, blocked),
      run(CASE_GATE_ON_ANSWERS, 3, { ...answered, 'answer-minimum': false }, blocked),
      run(CASE_GATE_OFF_ANSWERS, 1, answeredOff, { ...readNormally, denyMarkerAppeared: true }),
    ]);
    const statusById = Object.fromEntries(verdicts.map(item => [item.id, item.status]));

    expect(statusById['gate-on-deny-exercised']).toBe('pass');
    expect(statusById['gate-on-no-whole-file-read']).toBe('fail');
    expect(statusById['gate-on-attempts-denied']).toBe('fail');
    expect(statusById['gate-on-answers']).toBe('fail');
    expect(statusById['gate-on-edits']).toBe('not-run');
    expect(statusById['gate-off-never-denied']).toBe('fail');
    expect(statusById['gate-off-reads-succeed']).toBe('pass');
  });

  it('fails when gate-ON runs never tried a whole-file Read, which would pass the other gate-ON verdicts vacuously', () => {
    const verdicts = decideVerdicts([1, 2, 3].map(number => run(CASE_GATE_ON_ANSWERS, number, answered, {})));
    const statusById = Object.fromEntries(verdicts.map(item => [item.id, item.status]));

    expect(statusById['gate-on-deny-exercised']).toBe('fail');
    expect(statusById['gate-on-attempts-denied']).toBe('pass');
  });
});

describe('processesStillUsingArm', () => {
  const arm = { name: 'on' as const, dataDirectory: '/work/claude-mem 🧠 (copy)/.scratch/read-gate-eval/t/on/data', port: 51234 };
  type ProcessQueryResult = ReturnType<NonNullable<Parameters<typeof processesStillUsingArm>[1]>>;
  const nothingMatched: ProcessQueryResult = { status: 1, signal: null, stdout: '', stderr: '' };

  /** Stands in for spawnSync: each tool's canned answer (default: nothing matched), every call recorded. */
  function answering(answers: Partial<Record<'pgrep' | 'lsof', ProcessQueryResult>>) {
    const calls: Array<[string, string[]]> = [];
    const query = (command: string, args: string[]): ProcessQueryResult => {
      calls.push([command, args]);
      return answers[command as 'pgrep' | 'lsof'] ?? nothingMatched;
    };
    return { calls, query };
  }

  it('merges what pgrep and lsof find, drops this process, and gives pgrep the data dir as a literal pattern', () => {
    const { calls, query } = answering({
      pgrep: { status: 0, signal: null, stdout: `4100\n${process.pid}\n`, stderr: '' },
      lsof: { status: 0, signal: null, stdout: '4100\n4200\n', stderr: '' },
    });

    expect(processesStillUsingArm(arm, query)).toEqual([4100, 4200]);
    expect(calls).toEqual([
      ['pgrep', ['-f', '--', '/work/claude-mem 🧠 \\(copy\\)/\\.scratch/read-gate-eval/t/on/data']],
      ['lsof', ['-nP', '-iTCP:51234', '-sTCP:LISTEN', '-t']],
    ]);
  });

  it('reads exit 1 with nothing on stderr as nothing left', () => {
    expect(processesStillUsingArm(arm, answering({}).query)).toEqual([]);
  });

  it('throws, naming the tool, arm and port, when a tool cannot run', () => {
    // What Bun's spawnSync returns for a binary missing from PATH: error set, stdout null.
    const missing = spawnSync('read-gate-eval-no-such-tool', [], { encoding: 'utf8' });
    expect(missing.error).toBeDefined();

    expect(() => processesStillUsingArm(arm, answering({ pgrep: missing }).query))
      .toThrow(/^pgrep could not run .*the gate-on worker \(port 51234\)/);
    expect(() => processesStillUsingArm(arm, answering({ lsof: missing }).query))
      .toThrow(/^lsof could not run .*the gate-on worker \(port 51234\)/);
  });

  it('throws when pgrep fails, as with a pattern it cannot compile (exit 2)', () => {
    const query = answering({
      pgrep: { status: 2, signal: null, stdout: '', stderr: "pgrep: Cannot compile regular expression `x (' (parentheses not balanced)\n" },
    }).query;

    expect(() => processesStillUsingArm(arm, query)).toThrow(/^pgrep exited 2: pgrep: Cannot compile .*the gate-on worker \(port 51234\)/);
  });

  it('throws when lsof exits 1 with an error on stderr, unlike its silent exit 1 for no match', () => {
    const query = answering({
      lsof: { status: 1, signal: null, stdout: '', stderr: 'lsof: unacceptable port specification in: -i TCP:x\n' },
    }).query;

    expect(() => processesStillUsingArm(arm, query)).toThrow(/^lsof exited 1: lsof: unacceptable .*the gate-on worker \(port 51234\)/);
  });

  it.skipIf(!Bun.which('pgrep') || !Bun.which('lsof'))(
    'finds a process whose command line carries a data dir full of regex metacharacters, with the real pgrep and lsof',
    async () => {
      const dataDirectory = '/no/such/claude-mem 🧠 (1) a+b [c] {2} |^$?* back\\slash/.scratch/on/data';
      const listener = net.createServer();
      await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
      const port = (listener.address() as net.AddressInfo).port;
      const child = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 30000)', dataDirectory], { stdout: 'ignore', stderr: 'ignore' });
      try {
        // lsof finds this test process on the port, which is dropped like the runner itself.
        expect(processesStillUsingArm({ name: 'on', dataDirectory, port })).toEqual([child.pid]);
      } finally {
        child.kill();
        listener.close();
      }
    },
  );
});
