import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { HookSpool } from '../../src/shared/hook-spool.js';
import { findSecretSpans, isSecretFieldName, scrubSecretsToKindMarkers } from '../../src/utils/redaction.js';
import { scrubWireText, scrubWireSpoolPayload } from '../../src/services/wire-gateway/privacy/secret-scrub.js';
import {
  FileWireRecordingConsent,
  clearWireRecordings,
  readWireRecordingConsentFile,
  setWireRecordingConsent,
} from '../../src/services/wire-gateway/privacy/recording-consent.js';
import {
  WireTurnRecorder,
  recordedSessionFolderName,
  type WireGatewayTurn,
  type WireRecordingConsent,
} from '../../src/services/wire-gateway/capture/turn-recorder.js';
import { createHookSpoolCaptureEventSink } from '../../src/services/wire-gateway/capture/capture-event-sink.js';
import { loadWireGatewayConfig } from '../../src/services/wire-gateway/config.js';
import { runWireClearCli, runWireConsentCli } from '../../src/services/wire-gateway/WireGatewayService.js';

const testRoot = join(WIRE_GATEWAY_DIR, 'privacy-scrub-and-consent-test');
const consentFilePath = join(testRoot, 'consent.json');
const recordingsDirectory = join(testRoot, 'recordings');

const anthropicKey = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl';

beforeEach(() => rmSync(testRoot, { recursive: true, force: true }));
afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

function turnWith(input: string, output: string): WireGatewayTurn {
  return {
    agent: 'codex',
    session: 'thread-1',
    time: new Date().toISOString(),
    model: 'gpt-6',
    status: 200,
    input: [{ role: 'user', kind: 'text', text: input }, { role: 'assistant', kind: 'tool_use', name: 'shell', text: `{"cmd":"curl","api_key":"plainvalue","note":"${anthropicKey}"}` }],
    output: [{ role: 'assistant', kind: 'text', text: output }],
    routeId: 'codex',
    kind: 'turn',
  };
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
}

describe('secret detectors and the on-disk scrub (magpie TestScrub)', () => {
  it('finds each kind: API_KEY, TOKEN, PRIVATE_KEY, PASSWORD, SECRET', () => {
    const kindsIn = (text: string) => findSecretSpans(text).map(span => span.kind);
    expect(kindsIn(`key ${anthropicKey}`)).toEqual(['API_KEY']);
    expect(kindsIn(`gh ghp_0123456789abcdefghijABCDEFGHIJ0123 aws AKIAIOSFODNN7EXAMPLE`)).toEqual(['API_KEY', 'API_KEY']);
    expect(kindsIn(`jwt ${jwt}`)).toEqual(['TOKEN']);
    expect(kindsIn('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----')).toEqual(['PRIVATE_KEY']);
    expect(kindsIn('postgres://app:s3cretPass@db.internal/app')).toEqual(['PASSWORD']);
    expect(kindsIn('DB_PASSWORD=hunter2abc1')).toEqual(['SECRET']);
    expect(kindsIn('"clientSecret": "abc123def456"')).toEqual(['SECRET']);
    expect(kindsIn('"key": "oc0sk0abcdef0123456789"')).toEqual(['SECRET']);
    expect(kindsIn('the tokenizer splits words; max_tokens=4096; password = getPassword()')).toEqual([]);
  });

  it('stays fast on long runs that only start like a secret', () => {
    const longRun = `${'a'.repeat(200_000)}://${'b'.repeat(200_000)} ${'password'.repeat(20_000)}`;
    const startedAt = performance.now();
    findSecretSpans(longRun);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it('names secret fields, but not token counts', () => {
    for (const name of ['Authorization', 'x-api-key', 'Cookie', 'Set-Cookie', 'access_token', 'client_secret', 'X-Session-Token', 'key', 'DB_PASSWORD']) {
      expect({ name, secret: isSecretFieldName(name) }).toEqual({ name, secret: true });
    }
    for (const name of ['max_tokens', 'input_tokens', 'token_count', 'content', 'keyboard', 'sort_key']) {
      expect({ name, secret: isSecretFieldName(name) }).toEqual({ name, secret: false });
    }
  });

  it('scrubs a JSON body string by string, a secret-named field whole, and keeps data: values', () => {
    const body = `{"model":"m","max_tokens":100,"api_key":"plain-but-named","nested":{"access_token":"x","client_secret":"y"},`
      + `"messages":[{"role":"user","content":"my key is ${anthropicKey} and token ${jwt}"}],`
      + `"image":"data:image/png;base64,QUtJQUlPU0ZPRE5ON0VYQU1QTEU="}`;
    const scrubbed = scrubWireText(body);
    for (const secret of [anthropicKey, jwt, 'plain-but-named', '"x"', '"y"']) expect(scrubbed).not.toContain(secret);
    for (const kept of ['"max_tokens":100', '"model":"m"', '"api_key":"[REDACTED]"', '[REDACTED:API_KEY]', '[REDACTED:TOKEN]', 'data:image/png;base64,QUtJQUlPU0ZPRE5ON0VYQU1QTEU=']) {
      expect(scrubbed).toContain(kept);
    }
    expect(scrubbed).not.toContain('{{');
  });

  it('scrubs a stream line by line, and a cut body as text', () => {
    const stream = `event: message_start\ndata: {"type":"x","text":"${anthropicKey}","refresh_token":"r"}\n\ndata: [DONE]\n`;
    const scrubbedStream = scrubWireText(stream);
    expect(scrubbedStream).not.toContain(anthropicKey);
    expect(scrubbedStream).not.toContain('"r"');
    expect(scrubbedStream).toContain('event: message_start\n');
    expect(scrubbedStream).toContain('data: [DONE]\n');
    const cut = `{"messages":[{"content":"${anthropicKey}", "password": "hunter2hunter2`;
    const scrubbedCut = scrubWireText(cut);
    expect(scrubbedCut).not.toContain(anthropicKey);
    expect(scrubbedCut).not.toContain('hunter2hunter2');
    expect(scrubSecretsToKindMarkers('nothing here')).toBe('nothing here');
  });

  it('scrubs spooled capture events: prompt, tool input and response, last assistant message', () => {
    const spool = new HookSpool(join(testRoot, 'hook-spool'));
    const sink = createHookSpoolCaptureEventSink({ spool, nudgeWorker: () => undefined });
    sink.emit('session_init', { contentSessionId: 's1', platformSource: 'codex', prompt: `deploy with ${anthropicKey}` });
    sink.emit('observation', {
      contentSessionId: 's1', platformSource: 'codex', toolName: 'shell', toolUseId: 'call_1',
      toolInput: { cmd: `export OPENAI_API_KEY=sk-proj-abcdEFGH1234ijklMNOP5678qrst`, password: 'short' },
      toolResponse: `token ${jwt}`,
    });
    sink.emit('summarize', { contentSessionId: 's1', platformSource: 'codex', lastAssistantMessage: 'DB_PASSWORD=hunter2abc1 set' });
    const spooledText = JSON.stringify(spool.entries());
    for (const secret of [anthropicKey, 'sk-proj-abcdEFGH1234ijklMNOP5678qrst', jwt, 'hunter2abc1', '"short"']) expect(spooledText).not.toContain(secret);
    expect(spooledText).toContain('[REDACTED:API_KEY]');
    expect(spooledText).toContain('[REDACTED:TOKEN]');
    expect(spooledText).toContain('[REDACTED:SECRET]');
    expect(spooledText).toContain('"password":"[REDACTED]"');
    expect(spooledText).toContain('"toolUseId":"call_1"');
    // The payload handed in is never changed in place.
    const payload = { contentSessionId: 's1', platformSource: 'codex', prompt: anthropicKey };
    scrubWireSpoolPayload('session_init', payload);
    expect(payload.prompt).toBe(anthropicKey);
  });

  it('writes recorded turns scrubbed, never with a placeholder', () => {
    setWireRecordingConsent(true, consentFilePath);
    const recorder = new WireTurnRecorder({
      consent: new FileWireRecordingConsent({ recordingForcedOff: false, consentFilePath }),
      retentionDays: 7, recordingsDirectory, cleanupIntervalMs: 0,
    });
    try {
      const turn = turnWith(`here is ${anthropicKey} and {{API_KEY_abcdefgh}}`, `stored ${jwt}`);
      expect(recorder.save(turn, recorder.consent.recordingGeneration())).toBe('saved');
      const [turnsFile] = filesUnder(recordingsDirectory);
      const written = readFileSync(turnsFile, 'utf8');
      for (const secret of [anthropicKey, jwt, 'plainvalue']) expect(written).not.toContain(secret);
      expect(written).toContain('[REDACTED:API_KEY]');
      expect(written).toContain('[REDACTED:TOKEN]');
      expect(written).toContain('\\"api_key\\":\\"[REDACTED]\\"');
    } finally {
      recorder.dispose();
    }
  });
});

describe('recording consent', () => {
  it('is off with no decision, and an env value cannot turn it on', () => {
    const consent = new FileWireRecordingConsent({ recordingForcedOff: false, consentFilePath });
    expect(consent.isRecordingOn()).toBe(false);

    const settingsPath = join(testRoot, 'settings.json');
    mkdirSync(testRoot, { recursive: true });
    writeFileSync(settingsPath, '{}');
    const previous = process.env.CLAUDE_MEM_WIRE_GATEWAY_RECORDING;
    try {
      process.env.CLAUDE_MEM_WIRE_GATEWAY_RECORDING = 'true';
      expect(loadWireGatewayConfig(settingsPath).recordingForcedOff).toBe(false);
      expect(consent.isRecordingOn()).toBe(false);
      process.env.CLAUDE_MEM_WIRE_GATEWAY_RECORDING = 'false';
      const forcedOff = loadWireGatewayConfig(settingsPath).recordingForcedOff;
      expect(forcedOff).toBe(true);
      setWireRecordingConsent(true, consentFilePath);
      expect(new FileWireRecordingConsent({ recordingForcedOff: forcedOff, consentFilePath }).isRecordingOn()).toBe(false);
      expect(consent.isRecordingOn()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MEM_WIRE_GATEWAY_RECORDING;
      else process.env.CLAUDE_MEM_WIRE_GATEWAY_RECORDING = previous;
    }
  });

  it('treats an unreadable consent file as off', () => {
    mkdirSync(testRoot, { recursive: true });
    writeFileSync(consentFilePath, '{"recording":"yes"}');
    expect(new FileWireRecordingConsent({ recordingForcedOff: false, consentFilePath }).isRecordingOn()).toBe(false);
    expect(() => readWireRecordingConsentFile(consentFilePath)).toThrow();
  });

  it('refuses to turn recording on without a terminal', () => {
    const lines: string[] = [];
    const exitCode = runWireConsentCli(['--record'], {
      stdinIsTerminal: false, config: { retentionDays: 7, recordingForcedOff: false }, consentFilePath, recordingsDirectory,
      writeLine: line => lines.push(line), writeErrorLine: line => lines.push(line),
    });
    expect(exitCode).toBe(1);
    expect(lines.join('\n')).toContain('needs an interactive terminal');
    expect(existsSync(consentFilePath)).toBe(false);
  });

  it('refuses a non-terminal enable through the real command too (stdin piped)', async () => {
    const childDataDir = join(testRoot, 'child-data');
    const scriptPath = resolve(import.meta.dir, '../../src/services/wire-gateway/WireGatewayService.ts');
    const child = Bun.spawn([process.execPath, scriptPath, 'consent', '--record'], {
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: childDataDir },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    child.stdin.end();
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain('needs an interactive terminal');
    expect(existsSync(join(childDataDir, 'wire-gateway', 'consent.json'))).toBe(false);
  });

  it('turns on at a terminal after saying what is kept, where and for how long; --off turns it off', () => {
    const lines: string[] = [];
    const options = {
      stdinIsTerminal: true, config: { retentionDays: 7, recordingForcedOff: false }, consentFilePath, recordingsDirectory, writeLine: (line: string) => lines.push(line),
    };
    expect(runWireConsentCli(['--record'], options)).toBe(0);
    const said = lines.join('\n');
    expect(said).toContain('on this computer only');
    expect(said).toContain(recordingsDirectory);
    expect(said).toContain('7 days');
    expect(said).toContain('256 MiB');
    const on = readWireRecordingConsentFile(consentFilePath)!;
    expect(on.recording).toBe(true);
    expect(runWireConsentCli(['--off'], options)).toBe(0);
    const off = readWireRecordingConsentFile(consentFilePath)!;
    expect(off.recording).toBe(false);
    expect(off.generation).toBeGreaterThan(on.generation);
  });

  it('clear deletes the store and blocks in-flight saves, and says memories stay', () => {
    setWireRecordingConsent(true, consentFilePath);
    const consent = new FileWireRecordingConsent({ recordingForcedOff: false, consentFilePath });
    const recorder = new WireTurnRecorder({ consent, retentionDays: 7, recordingsDirectory, cleanupIntervalMs: 0 });
    try {
      expect(recorder.save(turnWith('first', 'one'), recorder.consent.recordingGeneration())).toBe('saved');
      expect(filesUnder(recordingsDirectory)).toHaveLength(1);
      const inFlightGeneration = recorder.consent.recordingGeneration();
      const lines: string[] = [];
      expect(runWireClearCli({ consentFilePath, recordingsDirectory, writeLine: line => lines.push(line) })).toBe(0);
      expect(lines.join('\n')).toContain('Memories that capture already created stay');
      expect(existsSync(recordingsDirectory)).toBe(false);
      expect(recorder.save(turnWith('in flight', 'two'), inFlightGeneration)).toBe('generation_changed');
      expect(filesUnder(recordingsDirectory)).toHaveLength(0);
      // Recording itself stays on: a request that starts after the clear is kept.
      expect(recorder.save(turnWith('after', 'three'), recorder.consent.recordingGeneration())).toBe('saved');
    } finally {
      recorder.dispose();
    }
  });

  it('takes a line back out when a clear lands between the check and the write', () => {
    let generationReads = 0;
    const racingConsent: WireRecordingConsent = {
      isRecordingOn: () => true,
      // The two checks before the write see generation 1; the clear lands, and the check after it sees 2.
      recordingGeneration: () => (++generationReads <= 2 ? 1 : 2),
    };
    const recorder = new WireTurnRecorder({ consent: racingConsent, retentionDays: 7, recordingsDirectory, cleanupIntervalMs: 0 });
    try {
      const turn = turnWith('raced', 'reply');
      expect(recorder.save(turn, 1)).toBe('generation_changed');
      const sessionFolder = join(recordingsDirectory, turn.time.slice(0, 10), recordedSessionFolderName(turn.agent, turn.session));
      expect(existsSync(join(sessionFolder, 'turns.jsonl'))).toBe(false);
    } finally {
      recorder.dispose();
    }
  });

  it('clear keeps the decision and bumps the generation', () => {
    const before = setWireRecordingConsent(true, consentFilePath);
    const after = clearWireRecordings({ consentFilePath, recordingsDirectory });
    expect(after.recording).toBe(true);
    expect(after.generation).toBe(before.generation + 1);
  });
});
