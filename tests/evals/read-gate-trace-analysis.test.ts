import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import net from 'net';
import {
  analyzeReadGateTrace,
  CASE_GATE_OFF_LARGE_FILE,
  CASE_GATE_OFF_SMALL_FILE,
  CASE_GATE_ON_EDITS,
  CASE_GATE_ON_LARGE_FILE,
  CASE_GATE_ON_SMALL_FILE,
  caseNameMatchesGlob,
  countLines,
  decideVerdicts,
  EVAL_CASE_NAMES,
  findIncompleteCaseRuns,
  GET_OBSERVATIONS_TOOL,
  isWholeFileRead,
  processesStillUsingArm,
  READ_GATE_DENY_MARKER,
  requestedCaseNames,
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
      JSON.stringify({
        type: 'result', subtype: 'success', num_turns: 6, total_cost_usd: 0.12,
        usage: { input_tokens: 10, output_tokens: 1938, cache_creation_input_tokens: 15066, cache_read_input_tokens: 67620, cache_creation: { ephemeral_1h_input_tokens: 7815 } },
      }),
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
      usage: { inputTokens: 10, outputTokens: 1938, cacheCreationInputTokens: 15066, cacheReadInputTokens: 67620 },
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

  it('reports a token count the result event leaves out as null, not zero', () => {
    const analysis = analyzeReadGateTrace([
      JSON.stringify({ type: 'result', usage: { input_tokens: 4, cache_creation_input_tokens: 18363, cache_read_input_tokens: 'n/a' } }),
    ], OPTIONS);

    expect(analysis.usage).toEqual({ inputTokens: 4, outputTokens: null, cacheCreationInputTokens: 18363, cacheReadInputTokens: null });
  });

  it('counts a cut-off line instead of throwing, and reports no usage without a result event', () => {
    const analysis = analyzeReadGateTrace(['{"type":"assistant","message":{"content":[', ''], OPTIONS);

    expect(analysis.unparsableLines).toBe(1);
    expect(analysis.wholeFileReadAttempts).toBe(0);
    expect(analysis.usage).toBeNull();
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

  function run(
    caseName: string,
    runNumber: number,
    graders: Record<string, boolean>,
    analysis: Partial<ReadGateTraceAnalysis>,
    costUsd = 0.1,
  ): RunEvidence {
    return {
      caseName, runNumber, graders,
      score: null, turns: 5, costUsd, error: null, aborted: null, tracePath: null,
      analysis: { ...noActivity, ...analysis },
    };
  }

  const blocked = { wholeFileReadAttempts: 1, wholeFileReadsDenied: 1, targetedReads: 1, targetedReadsSucceeded: 1, denyMarkerAppeared: true };
  const answered = { 'read-blocked': true, 'answer-rate': true, 'answer-minimum': true };
  const edited = { 'read-blocked': true, edited: true, 'old-value-gone': true };
  const readNormally = { wholeFileReadAttempts: 1, wholeFileReadsSucceeded: 1 };
  const answeredOff = { 'not-blocked': true, 'read-used': true, 'answer-rate': true, 'answer-minimum': true };

  it('passes every verdict when the gate blocks the large file, leaves the small one alone, and Claude still answers and edits', () => {
    const verdicts = decideVerdicts([
      ...[1, 2, 3].map(number => run(CASE_GATE_ON_LARGE_FILE, number, answered, blocked, 0.08)),
      ...[1, 2, 3].map(number => run(CASE_GATE_OFF_LARGE_FILE, number, answeredOff, readNormally, 0.12)),
      ...[1, 2, 3].map(number => run(CASE_GATE_ON_EDITS, number, edited, number === 3 ? {} : blocked)),
      ...[1, 2, 3].map(number => run(CASE_GATE_ON_SMALL_FILE, number, answeredOff, readNormally)),
      ...[1, 2, 3].map(number => run(CASE_GATE_OFF_SMALL_FILE, number, answeredOff, readNormally)),
    ]);

    expect(verdicts.map(item => [item.id, item.status])).toEqual([
      ['gate-on-deny-exercised', 'pass'],
      ['gate-on-no-whole-file-read', 'pass'],
      ['gate-on-attempts-denied', 'pass'],
      ['gate-on-edits', 'pass'],
      ['gate-on-small-file-not-denied', 'pass'],
      ['gate-on-small-file-answers', 'pass'],
      ['gate-off-never-denied', 'pass'],
      ['gate-off-reads-succeed', 'pass'],
      ['gate-off-answers', 'pass'],
      ['large-file-gate-on-answers', 'pass'],
      ['large-file-gate-off-answers', 'pass'],
      ['large-file-gate-on-denied', 'pass'],
      ['large-file-gate-off-reads-whole-file', 'pass'],
      ['large-file-gate-on-cheaper', 'pass'],
    ]);
    expect(verdicts.at(-1)?.detail).toBe('mean $0.080 gate ON vs $0.120 gate OFF (-33%)');
  });

  it('fails the large-file comparison when gate ON costs as much, or when gate OFF never read the whole file', () => {
    const verdicts = decideVerdicts([
      ...[1, 2, 3].map(number => run(CASE_GATE_ON_LARGE_FILE, number, answered, blocked, 0.12)),
      ...[1, 2, 3].map(number => run(CASE_GATE_OFF_LARGE_FILE, number, answeredOff, { targetedReads: 1, targetedReadsSucceeded: 1 }, 0.12)),
    ]);
    const statusById = Object.fromEntries(verdicts.map(item => [item.id, item.status]));

    expect(statusById['large-file-gate-on-cheaper']).toBe('fail');
    expect(statusById['large-file-gate-off-reads-whole-file']).toBe('fail');
    expect(statusById['gate-off-reads-succeed']).toBe('pass');
  });

  it('requires the deny in the large-file gate-ON runs themselves, not only in the other gate-ON cases', () => {
    const verdicts = decideVerdicts([
      ...[1, 2, 3, 4, 5, 6].map(number => run(CASE_GATE_ON_EDITS, number, edited, blocked)),
      ...[1, 2, 3].map(number => run(CASE_GATE_ON_LARGE_FILE, number, answered, { targetedReads: 1, targetedReadsSucceeded: 1 }, 0.08)),
      ...[1, 2, 3].map(number => run(CASE_GATE_OFF_LARGE_FILE, number, answeredOff, readNormally, 0.12)),
    ]);
    const statusById = Object.fromEntries(verdicts.map(item => [item.id, item.status]));

    expect(statusById['gate-on-deny-exercised']).toBe('pass');
    expect(statusById['large-file-gate-on-denied']).toBe('fail');
  });

  it('fails the large-file comparison when a compared run has no cost', () => {
    const verdicts = decideVerdicts([
      run(CASE_GATE_ON_LARGE_FILE, 1, answered, blocked, 0.08),
      { ...run(CASE_GATE_ON_LARGE_FILE, 2, answered, blocked), costUsd: null },
      run(CASE_GATE_OFF_LARGE_FILE, 1, answeredOff, readNormally, 0.12),
    ]);
    const comparison = verdicts.find(item => item.id === 'large-file-gate-on-cheaper');

    expect(comparison?.status).toBe('fail');
    expect(comparison?.detail).toBe(`no cost for ${CASE_GATE_ON_LARGE_FILE} #2`);
  });

  it('does not run the large-file comparison when --case left out one of its arms', () => {
    const verdicts = decideVerdicts([1, 2, 3].map(number => run(CASE_GATE_ON_LARGE_FILE, number, answered, blocked)));
    const statusById = Object.fromEntries(verdicts.map(item => [item.id, item.status]));

    expect(statusById['large-file-gate-on-cheaper']).toBe('not-run');
    expect(statusById['large-file-gate-on-answers']).toBe('pass');
    expect(statusById['gate-on-deny-exercised']).toBe('pass');
  });

  it('fails when a gated run read the whole file, gate off showed the marker, or too few answers passed', () => {
    const verdicts = decideVerdicts([
      run(CASE_GATE_ON_LARGE_FILE, 1, answered, { wholeFileReadAttempts: 1, wholeFileReadsSucceeded: 1 }),
      run(CASE_GATE_ON_LARGE_FILE, 2, { ...answered, 'answer-rate': false }, blocked),
      run(CASE_GATE_ON_LARGE_FILE, 3, { ...answered, 'answer-minimum': false }, blocked),
      run(CASE_GATE_OFF_SMALL_FILE, 1, answeredOff, { ...readNormally, denyMarkerAppeared: true }),
    ]);
    const statusById = Object.fromEntries(verdicts.map(item => [item.id, item.status]));

    expect(statusById['gate-on-deny-exercised']).toBe('pass');
    expect(statusById['gate-on-no-whole-file-read']).toBe('fail');
    expect(statusById['gate-on-attempts-denied']).toBe('fail');
    expect(statusById['large-file-gate-on-answers']).toBe('fail');
    expect(statusById['gate-on-edits']).toBe('not-run');
    expect(statusById['gate-off-never-denied']).toBe('fail');
    expect(statusById['gate-off-reads-succeed']).toBe('pass');
  });

  it('fails the small-file verdict when the gate denied a file under the deny size, or no Read went through', () => {
    const verdicts = decideVerdicts([
      run(CASE_GATE_ON_SMALL_FILE, 1, answeredOff, readNormally),
      run(CASE_GATE_ON_SMALL_FILE, 2, answeredOff, blocked),
      run(CASE_GATE_ON_SMALL_FILE, 3, answeredOff, {}),
    ]);
    const smallFileVerdict = verdicts.find(item => item.id === 'gate-on-small-file-not-denied');

    expect(smallFileVerdict?.status).toBe('fail');
    expect(smallFileVerdict?.detail).toBe(`denied or no successful Read: ${CASE_GATE_ON_SMALL_FILE} #2, ${CASE_GATE_ON_SMALL_FILE} #3`);
  });

  it('fails when gate-ON runs never tried a whole-file Read, which would pass the other gate-ON verdicts vacuously', () => {
    const verdicts = decideVerdicts([1, 2, 3].map(number => run(CASE_GATE_ON_LARGE_FILE, number, answered, {})));
    const statusById = Object.fromEntries(verdicts.map(item => [item.id, item.status]));

    expect(statusById['gate-on-deny-exercised']).toBe('fail');
    expect(statusById['gate-on-attempts-denied']).toBe('pass');
  });
});

describe('requestedCaseNames', () => {
  it('requests every case without --case, and the ones the glob selects with it', () => {
    expect(requestedCaseNames(null)).toEqual([
      CASE_GATE_ON_LARGE_FILE, CASE_GATE_OFF_LARGE_FILE, CASE_GATE_ON_EDITS, CASE_GATE_ON_SMALL_FILE, CASE_GATE_OFF_SMALL_FILE,
    ]);
    expect(requestedCaseNames('gate-on-*')).toEqual([CASE_GATE_ON_LARGE_FILE, CASE_GATE_ON_EDITS, CASE_GATE_ON_SMALL_FILE]);
    expect(requestedCaseNames('*-large-file')).toEqual([CASE_GATE_ON_LARGE_FILE, CASE_GATE_OFF_LARGE_FILE]);
    expect(requestedCaseNames(CASE_GATE_ON_EDITS)).toEqual([CASE_GATE_ON_EDITS]);
    expect(requestedCaseNames('*')).toEqual([...EVAL_CASE_NAMES]);
    expect(requestedCaseNames('no-such-case')).toEqual([]);
  });

  it('matches names as claude plugin eval --case does: whole name, * and ?, everything else literal', () => {
    expect(caseNameMatchesGlob('gate-o?-*', CASE_GATE_ON_SMALL_FILE)).toBe(true);
    expect(caseNameMatchesGlob('gate-o?-*', CASE_GATE_OFF_SMALL_FILE)).toBe(false);
    expect(caseNameMatchesGlob('gate-on', CASE_GATE_ON_SMALL_FILE)).toBe(false);
    expect(caseNameMatchesGlob('gate.on.*', CASE_GATE_ON_SMALL_FILE)).toBe(false);
    expect(caseNameMatchesGlob('(gate)-on-*', CASE_GATE_ON_SMALL_FILE)).toBe(false);
  });
});

describe('findIncompleteCaseRuns', () => {
  const noActivity = analyzeReadGateTrace([], OPTIONS);

  function completedRun(caseName: string, runNumber: number, overrides: Partial<RunEvidence> = {}): RunEvidence {
    return {
      caseName, runNumber, graders: {}, score: 1, turns: 5, costUsd: 0.1,
      error: null, aborted: null, tracePath: null, analysis: noActivity, ...overrides,
    };
  }

  const threeRunsEach = EVAL_CASE_NAMES.flatMap(caseName => [1, 2, 3].map(number => completedRun(caseName, number)));

  it('finds nothing when every requested case has every requested run, none errored or aborted', () => {
    expect(findIncompleteCaseRuns(threeRunsEach, EVAL_CASE_NAMES, 3)).toEqual([]);
  });

  it('names a case with fewer runs in the results than requested, and one with none', () => {
    const runs = threeRunsEach.filter(run =>
      !(run.caseName === CASE_GATE_ON_EDITS && run.runNumber === 3) && run.caseName !== CASE_GATE_OFF_SMALL_FILE);

    expect(findIncompleteCaseRuns(runs, EVAL_CASE_NAMES, 3)).toEqual([
      `${CASE_GATE_ON_EDITS} did not complete its runs: 2 of 3 requested runs in the results`,
      `${CASE_GATE_OFF_SMALL_FILE} did not complete its runs: 0 of 3 requested runs in the results`,
    ]);
  });

  it('names runs that ended with an error or that a mock aborted, even when every run is present', () => {
    const runs = threeRunsEach.map(run => {
      if (run.caseName === CASE_GATE_ON_SMALL_FILE && run.runNumber === 2) {
        return { ...run, error: 'scaffold failed (exit 1): cp: fixture: No such file or directory' };
      }
      if (run.caseName === CASE_GATE_ON_SMALL_FILE && run.runNumber === 3) {
        return { ...run, aborted: { server: 'mcp-search', tool: 'smart_outline', reason: 'abort_when matched' } };
      }
      return run;
    });

    expect(findIncompleteCaseRuns(runs, EVAL_CASE_NAMES, 3)).toEqual([
      `${CASE_GATE_ON_SMALL_FILE} did not complete its runs: `
        + 'run 2 ended with an error: scaffold failed (exit 1): cp: fixture: No such file or directory; '
        + 'run 3 was aborted by mock mcp-search/smart_outline: abort_when matched',
    ]);
  });

  it('checks only the requested cases, so a --case run is not failed for the cases it skipped', () => {
    const editRunsOnly = [1, 2].map(number => completedRun(CASE_GATE_ON_EDITS, number));

    expect(findIncompleteCaseRuns(editRunsOnly, requestedCaseNames(CASE_GATE_ON_EDITS), 2)).toEqual([]);
    expect(findIncompleteCaseRuns(editRunsOnly, requestedCaseNames('gate-on-*'), 2)).toEqual([
      `${CASE_GATE_ON_LARGE_FILE} did not complete its runs: 0 of 2 requested runs in the results`,
      `${CASE_GATE_ON_SMALL_FILE} did not complete its runs: 0 of 2 requested runs in the results`,
    ]);
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
