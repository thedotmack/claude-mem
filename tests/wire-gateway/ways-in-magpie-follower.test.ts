import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DATA_DIR, WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import type { HookSpoolKind, HookSpoolPayloadByKind } from '../../src/shared/hook-spool.js';
import { WireCaptureAssembler } from '../../src/services/wire-gateway/capture/capture-assembler.js';
import { TurnTracker } from '../../src/services/wire-gateway/identity/turn-tracker.js';
import { FOREIGN_SOURCE_SETTLE_MS, WireForeignCapture } from '../../src/services/wire-gateway/ingest/foreign-capture.js';
import {
  MagpieRecordingsFollower,
  defaultMagpieRecordingsDirectory,
  magpieFollowerActivity,
  magpieFollowerRequest,
  requestMagpieFollowerState,
  startingMagpieFollowerState,
  writeMagpieFollowerState,
} from '../../src/services/wire-gateway/ingest/magpie-follower.js';
import { addWireGatewayRoute } from '../../src/services/wire-gateway/routes.js';
import { runWireMagpieCli } from '../../src/services/wire-gateway/WireGatewayService.js';
import { logger } from '../../src/utils/logger.js';

// Plan Phase 13 task 3: the magpie recordings follower. Verification:
// follower partial lines, rotation, and no replay. The folder is outside
// claude-mem's own wire-gateway data (the follower refuses that one).

const testRoot = join(DATA_DIR, 'magpie-follower-test');
const recordingsDirectory = join(testRoot, 'magpie', 'gateway-conversations');
const statePath = join(testRoot, 'magpie-follower.json');
const routesFilePath = join(testRoot, 'routes.json');
const sandboxHome = join(testRoot, 'home');
const TURN_QUIET_MS_FOR_TEST = 30;
/** Short, so the gateway test does not wait the real 30 s; long against its 20 ms polls. */
const GATEWAY_SETTLE_MS_FOR_TEST = 300;

type SpooledEvent = { kind: HookSpoolKind; payload: HookSpoolPayloadByKind[HookSpoolKind] };
let events: SpooledEvent[];
let turnTracker: TurnTracker;
let capture: WireForeignCapture;
const spies: Array<ReturnType<typeof spyOn>> = [];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function eventsOf(kind: HookSpoolKind): Array<Record<string, unknown>> {
  return events.filter(event => event.kind === kind).map(event => event.payload as unknown as Record<string, unknown>);
}

function turnsFile(session: string, date = '2026-10-23'): string {
  const directory = join(recordingsDirectory, date, `hash-${session}`);
  mkdirSync(directory, { recursive: true });
  return join(directory, 'turns.jsonl');
}

/** magpie GatewayTurn lines (internal/sessions/gateway.go:37-46): a prompt that calls a tool, then the reply after its result. */
function promptLine(agent: string, session: string, prompt: string): string {
  return JSON.stringify({
    agent, session, time: '2026-10-23T10:00:00Z', model: 'gpt-6', status: 200,
    input: [{ role: 'system', kind: 'context', name: 'System prompt', text: 'You are an agent.' }, { role: 'user', kind: 'text', text: prompt }],
    output: [{ role: 'assistant', kind: 'tool_use', name: 'Bash', text: '{"command":"ls"}' }],
  });
}
function resultLine(agent: string, session: string, prompt: string): string {
  return JSON.stringify({
    agent, session, time: '2026-10-23T10:00:05Z', model: 'gpt-6', status: 200,
    input: [
      { role: 'system', kind: 'context', name: 'System prompt', text: 'You are an agent.' },
      { role: 'user', kind: 'text', text: prompt },
      { role: 'assistant', kind: 'tool_use', name: 'Bash', text: '{"command":"ls"}' },
      { role: 'tool', kind: 'tool_result', text: 'a.ts' },
    ],
    output: [{ role: 'assistant', kind: 'text', text: 'One file: a.ts.' }],
  });
}

function newFollower(options: { maxBytesPerPoll?: number } = {}): MagpieRecordingsFollower {
  return new MagpieRecordingsFollower({
    directory: recordingsDirectory,
    capture,
    statePath,
    captureSourceRule: { routesFilePath, environment: { home: sandboxHome, env: {}, platform: process.platform } },
    ...options,
  });
}

beforeEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(recordingsDirectory, { recursive: true });
  mkdirSync(sandboxHome, { recursive: true });
  events = [];
  const assembler = new WireCaptureAssembler({ eventSink: { emit: (kind, payload) => { events.push({ kind, payload }); } } });
  turnTracker = new TurnTracker({
    onTurnEnd: turnEnd => assembler.handleTurnEnd(turnEnd),
    onSessionStale: stale => assembler.handleSessionStale(stale),
    turnQuietMs: TURN_QUIET_MS_FOR_TEST,
    staleSweepIntervalMs: 0,
  });
  // Lines are decided as soon as they are seen here; the settle wait has its own tests below.
  capture = new WireForeignCapture({ assembler, turnTracker, settleMs: 0 });
  spies.push(spyOn(logger, 'debug').mockImplementation(() => {}), spyOn(logger, 'info').mockImplementation(() => {}));
});

afterEach(() => {
  turnTracker.dispose();
  spies.splice(0).forEach(spy => spy.mockRestore());
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('magpie recordings follower', () => {
  it('starts at the end (no replay of what magpie kept before), then reads lines as they come, into capture events', async () => {
    const file = turnsFile('s1');
    writeFileSync(file, `${promptLine('hermes', 'old', 'an old prompt')}\n${resultLine('hermes', 'old', 'an old prompt')}\n`);
    const follower = newFollower();
    expect(follower.poll()).toBe(0);
    expect(events).toEqual([]);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).files['2026-10-23/hash-s1/turns.jsonl'].offset).toBe(readFileSync(file).length);

    appendFileSync(file, `${promptLine('hermes', 's1', 'list the files')}\n`);
    expect(follower.poll()).toBe(1);
    expect(eventsOf('session_init')).toMatchObject([{ contentSessionId: 's1', platformSource: 'hermes', prompt: 'list the files' }]);
    appendFileSync(file, `${resultLine('hermes', 's1', 'list the files')}\n`);
    expect(follower.poll()).toBe(1);
    const [observation] = eventsOf('observation');
    expect(observation).toMatchObject({ contentSessionId: 's1', platformSource: 'hermes', toolName: 'Bash', toolInput: { command: 'ls' }, toolResponse: 'a.ts' });
    expect(String(observation.toolUseId)).toMatch(/^magpie-[0-9a-f]{32}$/);
    await sleep(TURN_QUIET_MS_FOR_TEST * 4);
    expect(eventsOf('summarize')).toEqual([{ contentSessionId: 's1', platformSource: 'hermes', lastAssistantMessage: 'One file: a.ts.' }]);
    // Nothing new: nothing read, nothing emitted again.
    expect(follower.poll()).toBe(0);
    expect(eventsOf('session_init')).toHaveLength(1);
    expect(eventsOf('observation')).toHaveLength(1);
  });

  it('reads complete lines only: a partial last line waits for its newline', () => {
    const file = turnsFile('s2');
    writeFileSync(file, '');
    const follower = newFollower();
    follower.poll();
    const line = promptLine('hermes', 's2', 'half a line');
    appendFileSync(file, line.slice(0, 40));
    expect(follower.poll()).toBe(0);
    expect(events).toEqual([]);
    appendFileSync(file, `${line.slice(40)}\n`);
    expect(follower.poll()).toBe(1);
    expect(eventsOf('session_init')).toMatchObject([{ contentSessionId: 's2', prompt: 'half a line' }]);
  });

  it('a replaced file (another inode) and a truncated one are read again from their start', () => {
    const file = turnsFile('s3');
    writeFileSync(file, `${promptLine('hermes', 's3', 'first prompt')}\n`);
    const follower = newFollower();
    follower.poll();
    expect(events).toEqual([]);

    // Rotation: a new file takes the path.
    const replacement = `${file}.new`;
    writeFileSync(replacement, `${promptLine('hermes', 's3-rotated', 'after rotation')}\n`);
    renameSync(replacement, file);
    expect(follower.poll()).toBe(1);
    expect(eventsOf('session_init')).toMatchObject([{ contentSessionId: 's3-rotated', prompt: 'after rotation' }]);

    // Truncation: same file, now shorter than where the follower got to.
    truncateSync(file, 0);
    writeFileSync(file, `${promptLine('hermes', 's3-t', 'x')}\n`);
    expect(follower.poll()).toBe(1);
    expect(eventsOf('session_init').map(init => init.contentSessionId)).toEqual(['s3-rotated', 's3-t']);
    expect(magpieFollowerActivity.filesRestarted).toBeGreaterThanOrEqual(2);
  });

  it('a restart continues from the saved offsets (no replay); a file that appears later is read whole', () => {
    const file = turnsFile('s4');
    writeFileSync(file, '');
    let follower = newFollower();
    follower.poll();
    appendFileSync(file, `${promptLine('hermes', 's4', 'before restart')}\n`);
    expect(follower.poll()).toBe(1);

    follower = newFollower();
    expect(follower.poll()).toBe(0);
    expect(eventsOf('session_init')).toHaveLength(1);

    writeFileSync(turnsFile('s5', '2026-10-24'), `${promptLine('hermes', 's5', 'a new session')}\n`);
    expect(follower.poll()).toBe(1);
    expect(eventsOf('session_init').map(init => init.prompt)).toEqual(['before restart', 'a new session']);
  });

  it('--backfill starts at the beginning of every recording there is', () => {
    writeFileSync(turnsFile('s6'), `${promptLine('hermes', 's6', 'kept before')}\n`);
    writeMagpieFollowerState(startingMagpieFollowerState(recordingsDirectory, true), statePath);
    expect(newFollower().poll()).toBe(1);
    expect(eventsOf('session_init')).toMatchObject([{ contentSessionId: 's6', prompt: 'kept before' }]);
  });

  it('never ingests a line of an agent claude-mem already captures (a wire route, or Claude Code on its hooks)', () => {
    addWireGatewayRoute({ routeId: 'hermes-route', agentId: 'hermes', upstreamBaseUrl: 'https://api.example.test' }, routesFilePath);
    const file = turnsFile('s7');
    writeFileSync(file, '');
    const follower = newFollower();
    follower.poll();
    appendFileSync(file, `${promptLine('hermes', 's7', 'wired')}\n${promptLine('claude', 's7c', 'claude code')}\n${promptLine('kimi', 's7k', 'not captured otherwise')}\n`);
    expect(follower.poll()).toBe(3);
    expect(eventsOf('session_init')).toMatchObject([{ platformSource: 'kimi', prompt: 'not captured otherwise' }]);
  });

  it('with no OTLP reaching claude-mem (the follower alone), every agent\'s lines are taken, session-traced agents too (P2)', () => {
    const file = turnsFile('s7t');
    writeFileSync(file, '');
    const follower = newFollower();
    follower.poll();
    appendFileSync(file, ['codex', 'opencode', 'gemini', 'pi', 'omp', 'claude-desktop', 'kimi'].map(agent => `${promptLine(agent, `s7-${agent}`, `from ${agent}`)}\n`).join(''));
    expect(follower.poll()).toBe(7);
    expect(eventsOf('session_init').map(init => init.platformSource)).toEqual(['codex', 'opencode', 'gemini-cli', 'pi', 'omp', 'claude-desktop', 'kimi']);
  });

  /** A capture on a clock the test moves, with the real settle time. */
  function settlingCapture(clock: { now: number }): WireForeignCapture {
    const assembler = new WireCaptureAssembler({ eventSink: { emit: (kind, payload) => { events.push({ kind, payload }); } } });
    return new WireForeignCapture({ assembler, turnTracker, now: () => clock.now });
  }

  it(`waits ${FOREIGN_SOURCE_SETTLE_MS / 1000} s before deciding a line, and skips it when magpie's OTLP spans (or the agent's own) for its agent arrived meanwhile (P2)`, () => {
    const clock = { now: 1_000_000 };
    const settling = settlingCapture(clock);
    const file = turnsFile('s7o');
    writeFileSync(file, '');
    const follower = new MagpieRecordingsFollower({ directory: recordingsDirectory, capture: settling, statePath, captureSourceRule: { routesFilePath, environment: { home: sandboxHome, env: {}, platform: process.platform } } });
    follower.poll();
    appendFileSync(file, ['codex', 'hermes', 'kimi'].map(agent => `${promptLine(agent, `s7o-${agent}`, `from ${agent}`)}\n`).join(''));
    clock.now += 2_000;
    expect(follower.poll()).toBe(0); // seen, not yet decided
    // magpie's export delivers codex's copy (a gateway or session span); hermes sends its own GenAI spans; kimi's copy never comes.
    clock.now += 5_000;
    settling.observeToolRun({ source: 'otlp', channel: 'magpie_session_span', agentId: 'codex', sessionId: 's7o-codex', callId: 'c1', toolName: 'Bash', argsText: '{}', resultText: '' }, settling.checkForBatch({ routesFilePath }));
    settling.deliveries.record('agent_otlp', 'hermes', clock.now);
    clock.now += FOREIGN_SOURCE_SETTLE_MS - 5_000 - 1; // 1 ms short of the settle time since the line was seen
    expect(follower.poll()).toBe(0);
    clock.now += 1;
    expect(follower.poll()).toBe(3);
    expect(eventsOf('session_init').map(init => init.platformSource)).toEqual(['kimi']);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).files['2026-10-23/hash-s7o/turns.jsonl']).toEqual({ inode: expect.any(String), offset: readFileSync(file).length });
  });

  it('lines seen before a restart are decided as they would have been; lines written while claude-mem was down are taken (P2)', () => {
    const clock = { now: 2_000_000 };
    const before = settlingCapture(clock);
    const rule = { routesFilePath, environment: { home: sandboxHome, env: {}, platform: process.platform } };
    const file = turnsFile('s7r');
    writeFileSync(file, '');
    const first = new MagpieRecordingsFollower({ directory: recordingsDirectory, capture: before, statePath, captureSourceRule: rule });
    first.poll();
    appendFileSync(file, `${promptLine('codex', 's7r', 'seen before the restart')}\n`);
    clock.now += 1_000;
    expect(first.poll()).toBe(0);
    clock.now += 3_000;
    before.deliveries.record('magpie_otlp', 'codex', clock.now);
    clock.now += 1_000;
    expect(first.poll()).toBe(0); // still waiting; the delivery is saved with the line
    // The gateway stops; magpie records a call meanwhile (its OTLP export to claude-mem fails then).
    appendFileSync(file, `${promptLine('codex', 's7r-down', 'while claude-mem was down')}\n`);
    clock.now += 60_000;
    const after = settlingCapture(clock);
    const second = new MagpieRecordingsFollower({ directory: recordingsDirectory, capture: after, statePath, captureSourceRule: rule });
    // The line seen before is decided by what arrived then (magpie carried it); the one written while down is taken at once.
    expect(second.poll()).toBe(2);
    expect(eventsOf('session_init').map(init => init.prompt)).toEqual(['while claude-mem was down']);
  });

  it('wire magpie enable --backfill while a follower runs takes effect at its next look, never undone by its next save (P2-c)', () => {
    const file = turnsFile('s11');
    writeFileSync(file, `${promptLine('kimi', 's11', 'kept before')}\n`);
    const follower = newFollower();
    expect(follower.poll()).toBe(0);
    const settingsPath = join(testRoot, 'settings.json');
    expect(runWireMagpieCli(['enable', '--backfill', '--dir', recordingsDirectory], { settingsPath, statePath, writeLine: () => undefined, writeErrorLine: () => undefined })).toBe(0);
    // The running follower's next look starts from the beginning, as asked.
    expect(follower.poll()).toBe(1);
    expect(eventsOf('session_init')).toMatchObject([{ contentSessionId: 's11', prompt: 'kept before' }]);
    expect(existsSync(`${statePath}.pending`)).toBe(false);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).files['2026-10-23/hash-s11/turns.jsonl'].offset).toBe(readFileSync(file).length);
    expect(magpieFollowerActivity.statesTakenUp).toBeGreaterThanOrEqual(1);
    // Taken up once.
    expect(follower.poll()).toBe(0);
  });

  it('wire magpie enable --dir <another folder> is left for a follower of that folder, loudly, and taken up by it (P2-c)', () => {
    const warnings: unknown[] = [];
    spies.push(spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args); }));
    const otherDirectory = join(testRoot, 'other-magpie', 'gateway-conversations');
    const otherFile = join(otherDirectory, '2026-10-23', 'hash-o1', 'turns.jsonl');
    mkdirSync(join(otherDirectory, '2026-10-23', 'hash-o1'), { recursive: true });
    writeFileSync(otherFile, `${promptLine('kimi', 'o1', 'in the other folder')}\n`);
    const follower = newFollower();
    follower.poll();
    const settingsPath = join(testRoot, 'settings.json');
    expect(runWireMagpieCli(['enable', '--backfill', '--dir', otherDirectory], { settingsPath, statePath, writeLine: () => undefined, writeErrorLine: () => undefined })).toBe(0);
    follower.poll();
    follower.poll();
    expect(existsSync(`${statePath}.pending`)).toBe(true);
    expect(warnings.filter(args => String((args as unknown[])[1]).includes('another folder'))).toHaveLength(1);
    // The gateway restarted on the other folder: its follower starts where enable asked (the beginning).
    const otherFollower = new MagpieRecordingsFollower({ directory: otherDirectory, capture, statePath, captureSourceRule: { routesFilePath, environment: { home: sandboxHome, env: {}, platform: process.platform } } });
    expect(otherFollower.poll()).toBe(1);
    expect(eventsOf('session_init')).toMatchObject([{ contentSessionId: 'o1' }]);
    expect(existsSync(`${statePath}.pending`)).toBe(false);
  });

  it('refuses a symlink to claude-mem\'s own data, and follows no symlinked recording (P3-5)', () => {
    const linkToOwn = join(testRoot, 'link-to-own');
    mkdirSync(WIRE_GATEWAY_DIR, { recursive: true });
    symlinkSync(WIRE_GATEWAY_DIR, linkToOwn);
    expect(() => new MagpieRecordingsFollower({ directory: linkToOwn, capture, statePath })).toThrow('claude-mem\'s own wire recordings');

    const warnings: unknown[] = [];
    spies.push(spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args); }));
    const elsewhere = join(testRoot, 'elsewhere.jsonl');
    writeFileSync(elsewhere, '');
    mkdirSync(join(recordingsDirectory, '2026-10-23', 'hash-link'), { recursive: true });
    symlinkSync(elsewhere, join(recordingsDirectory, '2026-10-23', 'hash-link', 'turns.jsonl'));
    const follower = newFollower();
    follower.poll();
    appendFileSync(elsewhere, `${promptLine('kimi', 'linked', 'through a link')}\n`);
    expect(follower.poll()).toBe(0);
    follower.poll();
    expect(events).toEqual([]);
    expect(warnings.filter(args => String((args as unknown[])[1]).includes('symlink'))).toHaveLength(1);
  });

  it('reports a line too long for any poll in a file whose turn comes after busy ones (P3-6)', () => {
    const errors: unknown[] = [];
    spies.push(spyOn(logger, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); }));
    const busy = turnsFile('a-busy');
    const quiet = turnsFile('b-long');
    writeFileSync(busy, '');
    writeFileSync(quiet, '');
    const busyLine = promptLine('kimi', 'busy', 'busy');
    const budget = 2 * busyLine.length;
    const follower = newFollower({ maxBytesPerPoll: budget });
    follower.poll();
    appendFileSync(quiet, `${'x'.repeat(budget * 3)}\n${promptLine('kimi', 'after-long', 'after')}\n`);
    // The busy file takes half the budget every poll, ahead of the long line in sort order.
    for (let polls = 0; polls < 20; polls++) {
      appendFileSync(busy, `${busyLine}\n`);
      follower.poll();
    }
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(String((errors[0] as unknown[])[1])).toContain('longer than a whole poll');
    expect(eventsOf('session_init').map(init => init.contentSessionId)).toContain('after-long');
  });

  it('logs no text of a malformed line (P3-4)', () => {
    const warnings: unknown[] = [];
    spies.push(spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args); }));
    const file = turnsFile('s12');
    writeFileSync(file, '');
    const follower = newFollower();
    follower.poll();
    appendFileSync(file, 'ghp_abcdefghijklmnopqrstuvwxyz0123456789 is not json\n');
    expect(follower.poll()).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain('ghp_');
  });

  it('reads at most its budget per poll, and skips a line longer than a whole poll, loudly', () => {
    const errors: unknown[] = [];
    spies.push(spyOn(logger, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); }));
    const file = turnsFile('s8');
    writeFileSync(file, '');
    const line = promptLine('hermes', 's8', 'short');
    // Room for one line and most of the next: one line a poll.
    const budget = 2 * line.length;
    const follower = newFollower({ maxBytesPerPoll: budget });
    follower.poll();
    appendFileSync(file, `${line}\n${promptLine('hermes', 's8b', 'next')}\n`);
    expect(follower.poll()).toBe(1);
    expect(follower.poll()).toBe(1);
    appendFileSync(file, `${'x'.repeat(budget * 3)}\n${promptLine('hermes', 's8c', 'after')}\n`);
    let lines = 0;
    for (let polls = 0; polls < 6; polls++) lines += follower.poll();
    expect(lines).toBe(1);
    expect(eventsOf('session_init').map(init => init.prompt)).toEqual(['short', 'next', 'after']);
    expect(errors).toHaveLength(1);
  });

  it('refuses to follow claude-mem\'s own wire-gateway data', () => {
    expect(() => new MagpieRecordingsFollower({ directory: join(WIRE_GATEWAY_DIR, 'recordings'), capture, statePath })).toThrow('claude-mem\'s own wire recordings');
  });
});

describe('claude-mem wire magpie enable|disable', () => {
  it('finds ~/.config/magpie/gateway-conversations (or $XDG_CONFIG_HOME/magpie), writes the setting and a state that starts at the end', () => {
    expect(defaultMagpieRecordingsDirectory({ env: {}, home: '/home/me' })).toBe('/home/me/.config/magpie/gateway-conversations');
    expect(defaultMagpieRecordingsDirectory({ env: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/me' })).toBe('/xdg/magpie/gateway-conversations');
    expect(defaultMagpieRecordingsDirectory({ env: { XDG_CONFIG_HOME: 'relative' }, home: '/home/me' })).toBe('/home/me/.config/magpie/gateway-conversations');

    const file = turnsFile('s9');
    writeFileSync(file, `${promptLine('hermes', 's9', 'already there')}\n`);
    const settingsPath = join(testRoot, 'settings.json');
    const lines: string[] = [];
    const exitCode = runWireMagpieCli(['enable'], {
      settingsPath, statePath, environment: { env: { XDG_CONFIG_HOME: join(testRoot) }, home: sandboxHome }, writeLine: line => lines.push(line), writeErrorLine: line => lines.push(line),
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).CLAUDE_MEM_WIRE_GATEWAY_MAGPIE_RECORDINGS_DIR).toBe(recordingsDirectory);
    // The follower's own state is written by the follower only; enable asks beside it.
    expect(existsSync(statePath)).toBe(false);
    expect(JSON.parse(readFileSync(`${statePath}.pending`, 'utf8')).files['2026-10-23/hash-s9/turns.jsonl'].offset).toBe(readFileSync(file).length);
    expect(lines.join('\n')).toContain('claude-mem wire restart');
    expect(newFollower().poll()).toBe(0);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).files['2026-10-23/hash-s9/turns.jsonl'].offset).toBe(readFileSync(file).length);

    expect(runWireMagpieCli(['disable'], { settingsPath, writeLine: () => undefined })).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).CLAUDE_MEM_WIRE_GATEWAY_MAGPIE_RECORDINGS_DIR).toBe('');
  });

  it('refuses a folder that does not exist, and an unknown flag', () => {
    const errors: string[] = [];
    const settingsPath = join(testRoot, 'settings.json');
    expect(runWireMagpieCli(['enable', '--dir', join(testRoot, 'nope')], { settingsPath, statePath, writeErrorLine: line => errors.push(line) })).toBe(1);
    expect(errors[0]).toContain('No magpie recordings');
    expect(runWireMagpieCli(['enable', '--bogus'], { settingsPath, statePath, writeErrorLine: line => errors.push(line) })).toBe(1);
    expect(existsSync(settingsPath)).toBe(false);
  });
});

describe('the gateway runs the follower', () => {
  it('with CLAUDE_MEM_WIRE_GATEWAY_MAGPIE_RECORDINGS_DIR set, lines become capture events, and wire status counts them', async () => {
    const { startWireGatewayForTest } = await import('./helpers/start-wire-gateway.js');
    const { formatWireIngestStatus } = await import('../../src/services/wire-gateway/drift/agent-status.js');
    const file = turnsFile('s10');
    writeFileSync(file, '');
    const gatewayEvents: SpooledEvent[] = [];
    const gateway = await startWireGatewayForTest({
      routesFilePath,
      magpieRecordingsDirectory: recordingsDirectory,
      capture: { eventSink: { emit: (kind, payload) => { gatewayEvents.push({ kind, payload }); } }, staleSweepIntervalMs: 0 },
      ingest: {
        magpieStatePath: statePath,
        magpiePollIntervalMs: 20,
        foreignSourceSettleMs: GATEWAY_SETTLE_MS_FOR_TEST,
        captureSourceRule: { routesFilePath, environment: { home: sandboxHome, env: {}, platform: process.platform } },
      },
      status: { agentEnvironment: { home: sandboxHome, env: {}, platform: process.platform }, wiringDirectory: join(testRoot, 'wiring'), userAgentsDirectory: join(testRoot, 'agents') },
    });
    try {
      expect(gateway.service.magpieFollower?.directory).toBe(recordingsDirectory);
      appendFileSync(file, `${promptLine('hermes', 's10', 'through the daemon')}\n`);
      for (let attempt = 0; attempt < 100 && gatewayEvents.length === 0; attempt++) await sleep(20);
      expect(gatewayEvents.map(event => event.kind)).toEqual(['session_init']);
      const report = await gateway.service.statusReport();
      expect(report.ingest?.magpie.directory).toBe(recordingsDirectory);
      expect(report.ingest?.magpie.exchanges).toBeGreaterThanOrEqual(1);
      expect(formatWireIngestStatus(report.ingest!).join('\n')).toContain(`magpie following ${recordingsDirectory}`);

      // P2: magpie's OTLP export reaches claude-mem too. Its gateway span for kimi is captured; the recorded line of
      // the same exchange, which appears moments later, is skipped once it has settled.
      const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
      const gatewaySpan = {
        traceId: '5b8efff798038103d269b633813fc60c', spanId: 'aaaaaaaaaaaa0001', name: 'chat gpt-6', kind: 3,
        attributes: [
          attribute('magpie.agent', 'kimi'), attribute('gen_ai.request.model', 'gpt-6'),
          attribute('langfuse.observation.input', JSON.stringify({ model: 'gpt-6', messages: [{ role: 'user', content: 'over OTLP and recorded' }] })),
          attribute('langfuse.observation.output', JSON.stringify({ id: 'c1', object: 'chat.completion', model: 'gpt-6', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })),
        ],
      };
      const response = await fetch(`${gateway.baseUrl}/v1/traces`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [attribute('service.name', 'magpie')] }, scopeSpans: [{ spans: [gatewaySpan] }] }] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
      for (let attempt = 0; attempt < 100 && !gatewayEvents.some(event => (event.payload as { prompt?: string }).prompt === 'over OTLP and recorded'); attempt++) await sleep(20);
      const eventsBefore = gatewayEvents.length;
      const skippedBefore = (await gateway.service.statusReport()).ingest!.magpie.skippedOtherSource;
      appendFileSync(file, `${promptLine('kimi', 's10k', 'over OTLP and recorded')}\n`);
      for (let attempt = 0; attempt < 100 && (await gateway.service.statusReport()).ingest!.magpie.skippedOtherSource === skippedBefore; attempt++) await sleep(20);
      expect((await gateway.service.statusReport()).ingest!.magpie.skippedOtherSource).toBe(skippedBefore + 1);
      expect(gatewayEvents.length).toBe(eventsBefore);
    } finally {
      await gateway.stop();
    }
    expect(gateway.service.magpieFollower).toBeNull();
  });
});

describe('wire magpie enable requests, taken up safely (P3)', () => {
  const settingsPath = () => join(testRoot, 'settings.json');
  const quiet = { writeLine: () => undefined, writeErrorLine: () => undefined };
  const appendPrompts = (file: string, session: string, count: number, first = 0) =>
    appendFileSync(file, Array.from({ length: count }, (_, n) => `${promptLine('kimi', session, `prompt ${first + n}`)}\n`).join(''));

  it('enable again (no --backfill) for the folder a lagging follower follows skips none of its unread lines', () => {
    const file = turnsFile('r1');
    writeFileSync(file, '');
    const oneLine = Buffer.byteLength(`${promptLine('kimi', 'r1', 'prompt 0')}\n`);
    const follower = newFollower({ maxBytesPerPoll: oneLine });
    follower.poll();
    appendPrompts(file, 'r1', 4);
    expect(follower.poll()).toBe(1);
    expect(runWireMagpieCli(['enable', '--dir', recordingsDirectory], { settingsPath: settingsPath(), statePath, ...quiet })).toBe(0);
    let read = 1;
    for (let poll = 0; poll < 5; poll++) read += follower.poll();
    expect(read).toBe(4);
    expect(eventsOf('session_init').map(init => init.prompt)).toEqual(['prompt 0', 'prompt 1', 'prompt 2', 'prompt 3']);
    expect(existsSync(`${statePath}.pending`)).toBe(false);
  });

  it('enable again while the gateway is down: the follower that starts next goes on from where it got to', () => {
    const file = turnsFile('r2');
    writeFileSync(file, '');
    const before = newFollower();
    before.poll();
    appendPrompts(file, 'r2', 1);
    expect(before.poll()).toBe(1);
    before.stop();
    // Down: magpie records two more calls, and enable runs again.
    appendPrompts(file, 'r2', 2, 1);
    expect(runWireMagpieCli(['enable', '--dir', recordingsDirectory], { settingsPath: settingsPath(), statePath, ...quiet })).toBe(0);
    expect(newFollower().poll()).toBe(2);
    expect(eventsOf('session_init').map(init => init.prompt)).toEqual(['prompt 0', 'prompt 1', 'prompt 2']);
  });

  it('a request a crash left claimed is taken up at the next look, and one applied already is never applied twice', () => {
    const file = turnsFile('r3');
    writeFileSync(file, `${promptLine('kimi', 'r3', 'kept before')}\n`);
    const follower = newFollower();
    expect(follower.poll()).toBe(0);
    // Crash after the claim, before the state was written: the claimed file stays behind.
    const request = magpieFollowerRequest(recordingsDirectory, true);
    requestMagpieFollowerState(request, statePath);
    renameSync(`${statePath}.pending`, `${statePath}.pending.99999.taking`);
    expect(newFollower().poll()).toBe(1);
    expect(existsSync(`${statePath}.pending.99999.taking`)).toBe(false);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).takenRequestId).toBe(request.requestId);
    // Crash after the state was written, before the claimed file was removed: removed, not applied again (no second backfill).
    requestMagpieFollowerState(request, statePath);
    renameSync(`${statePath}.pending`, `${statePath}.pending.99998.taking`);
    expect(newFollower().poll()).toBe(0);
    expect(existsSync(`${statePath}.pending.99998.taking`)).toBe(false);
    expect(eventsOf('session_init')).toHaveLength(1);
  });

  it('an unreadable request is reported once, with what to do, and following goes on', () => {
    const errors: unknown[][] = [];
    spies.push(spyOn(logger, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); }));
    const file = turnsFile('r4');
    writeFileSync(file, '');
    const follower = newFollower();
    follower.poll();
    writeFileSync(`${statePath}.pending`, JSON.stringify({ version: 99, directory: recordingsDirectory, files: {} }));
    const unreadableBefore = magpieFollowerActivity.requestsUnreadable;
    appendPrompts(file, 'r4', 1);
    expect(follower.poll()).toBe(1);
    appendPrompts(file, 'r4', 1, 1);
    expect(follower.poll()).toBe(1);
    expect(eventsOf('session_init')).toHaveLength(2);
    expect(errors).toHaveLength(1);
    const message = (errors[0][3] as Error).message;
    expect(message).toContain('is not a request from `claude-mem wire magpie enable`');
    expect(message).toContain('Run `claude-mem wire magpie enable` again to replace it, or delete it');
    expect(message).not.toContain('deleting starts at the end');
    expect(magpieFollowerActivity.requestsUnreadable).toBe(unreadableBefore + 1);
    expect(existsSync(`${statePath}.pending`)).toBe(true);
  });

  it('a failed enable changes nothing: no request when the setting cannot be written, and the setting put back when the request cannot be', () => {
    const file = turnsFile('r5');
    writeFileSync(file, `${promptLine('kimi', 'r5', 'kept before')}\n`);
    writeFileSync(join(testRoot, 'a-file'), '');
    // The setting cannot be written.
    expect(runWireMagpieCli(['enable', '--backfill', '--dir', recordingsDirectory], { settingsPath: join(testRoot, 'a-file', 'settings.json'), statePath, ...quiet })).toBe(1);
    expect(existsSync(`${statePath}.pending`)).toBe(false);
    // The request cannot be written: the setting goes back to what it was (here: absent, in a file that existed).
    writeFileSync(settingsPath(), JSON.stringify({ CLAUDE_MEM_MODEL: 'kept' }));
    const errors: string[] = [];
    expect(runWireMagpieCli(['enable', '--backfill', '--dir', recordingsDirectory], { settingsPath: settingsPath(), statePath: join(testRoot, 'a-file', 'state.json'), writeLine: () => undefined, writeErrorLine: line => errors.push(line) })).toBe(1);
    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({ CLAUDE_MEM_MODEL: 'kept' });
    expect(errors.join('\n')).toContain('Could not write the follower\'s start request');
    // …and when settings.json did not exist, it is not left behind.
    rmSync(settingsPath());
    expect(runWireMagpieCli(['enable', '--dir', recordingsDirectory], { settingsPath: settingsPath(), statePath: join(testRoot, 'a-file', 'state.json'), ...quiet })).toBe(1);
    expect(existsSync(settingsPath())).toBe(false);
  });
});
