import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { OutboundRedactionPlaceholders } from '../../src/services/wire-gateway/privacy/outbound-redaction.js';
import { PlaceholderRestoringResponse } from '../../src/services/wire-gateway/privacy/placeholder-restoring-response.js';
import {
  scrubWireRecorderPart,
  scrubWireSpoolPayload,
  scrubWireStructuredValue,
  scrubWireText,
} from '../../src/services/wire-gateway/privacy/secret-scrub.js';
import { readWireRecordingConsentFile, setWireRecordingConsent } from '../../src/services/wire-gateway/privacy/recording-consent.js';

// Fixes for the PR #4800 security review: secret-named fields masked
// upstream and scrubbed whatever their value's type, multiline secrets in a
// stream-looking text, placeholders put back inside a streamed Gemini
// functionCall's args, and consent writes serialized across processes.

const testRoot = join(WIRE_GATEWAY_DIR, 'privacy-review-fixes-test');
const keyFilePath = join(testRoot, 'redact.key');
const consentFilePath = join(testRoot, 'consent.json');
const recordingsDirectory = join(testRoot, 'recordings');
const recordingConsentModulePath = resolve(import.meta.dir, '../../src/services/wire-gateway/privacy/recording-consent.ts');

let placeholders: OutboundRedactionPlaceholders;

beforeEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  placeholders = new OutboundRedactionPlaceholders({ keyFilePath });
});
afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

function maskJson(body: string): string {
  return new TextDecoder().decode(placeholders.maskRequestBody(new TextEncoder().encode(body)).bytes);
}

describe('maskRequestBody masks the value of a secret-named field (review thread 1)', () => {
  const bodies: Record<string, string> = {
    'anthropic tool_use input': '{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"login","input":{"password":"hunter2abc1","username":"alex"}}]}]}',
    'gemini functionCall object args': '{"contents":[{"role":"model","parts":[{"functionCall":{"name":"login","args":{"password":"hunter2abc1","username":"alex"}}}]}]}',
    'a plain request field': '{"messages":[{"role":"user","content":"hi"}],"metadata":{"client_secret":"hunter2abc1"}}',
    'an array under a secret-named field': '{"contents":[{"parts":[{"functionCall":{"name":"f","args":{"api_keys":["hunter2abc1"]}}}]}]}',
  };
  for (const [name, body] of Object.entries(bodies)) {
    it(`does not send a short password upstream: ${name}`, () => {
      const masked = maskJson(body);
      expect(masked).not.toContain('hunter2abc1');
      expect(masked).toMatch(/\{\{SECRET_[a-z2-7]{8}\}\}/);
      if (body.includes('"alex"')) expect(masked).toContain('"username":"alex"');
      expect(placeholders.restoreJsonText(masked)).toBe(body);
    });
  }

  it('keeps the position-based exemptions: definitions, ids, sealed values and data: URLs', () => {
    const kept = [
      '{"messages":[{"role":"user","content":"hi"}],"tools":[{"name":"t","input_schema":{"properties":{"token":{"type":"string","default":"hunter2abc1"}}},"token":"hunter2abc1"}]}',
      '{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"x","signature":"sig","secret":"hunter2abc1"}]}]}',
      '{"token_id":"hunter2abc1"}',
      '{"password":"data:text/plain;base64,aGk="}',
      '{"password":""}',
    ];
    for (const body of kept) expect(maskJson(body)).toBe(body);
  });
});

describe('scrubWireText scrubs a multiline secret in a text with data: lines (review thread 2)', () => {
  it('removes a PEM private key that sits between stream lines', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretbody\n-----END RSA PRIVATE KEY-----';
    const text = `data: {"type":"x"}\n\nnote: ${pem}\ndata: {"type":"y"}\n`;
    const scrubbed = scrubWireText(text);
    expect(scrubbed).not.toContain('MIIEowIBAAKCAQEAsecretbody');
    expect(scrubbed).toContain('[REDACTED:PRIVATE_KEY]');
    expect(scrubbed).toContain('data: {"type":"x"}\n\n');
    expect(scrubbed).toContain('data: {"type":"y"}\n');
  });
});

describe('a secret-named field goes whole whatever its value is (review thread 3)', () => {
  it('scrubWireStructuredValue replaces numbers, objects and arrays under a secret-named key', () => {
    const scrubbed = scrubWireStructuredValue({
      password: 12345678,
      credentials: { user: 'alex', pin: '0000' },
      api_keys: ['abc', 'def'],
      note: 'ok',
      usage: { output_tokens: 7 },
    });
    expect(scrubbed).toEqual({
      password: '[REDACTED]',
      credentials: '[REDACTED]',
      api_keys: '[REDACTED]',
      note: 'ok',
      usage: { output_tokens: 7 },
    });
  });

  it('a spooled tool input loses a numeric password and a credentials object', () => {
    const payload = scrubWireSpoolPayload('observation', {
      contentSessionId: 's', platformSource: 'wire', toolName: 'login',
      toolInput: { password: 12345678, credentials: { user: 'alex' } }, toolResponse: 'ok', cwd: '/x',
    } as never) as { toolInput: unknown };
    expect(payload.toolInput).toEqual({ password: '[REDACTED]', credentials: '[REDACTED]' });
  });

  it('the JSON text a recorder keeps loses non-string secret-named values, as JSON and as stream lines', () => {
    const json = '{"input":{"password":12345678,"credentials":{"user":"alex","pin":"0000"},"tokens":[1,2]},"usageMetadata":{"promptTokenCount":5},"usage":{"prompt_tokens_details":{"cached_tokens":3}}}';
    const expected = '{"input":{"password":"[REDACTED]","credentials":"[REDACTED]","tokens":[1,2]},"usageMetadata":{"promptTokenCount":5},"usage":{"prompt_tokens_details":{"cached_tokens":3}}}';
    expect(scrubWireText(json)).toBe(expected);
    expect(scrubWireText(`data: ${json}\n\n`)).toBe(`data: ${expected}\n\n`);
    expect(scrubWireRecorderPart({ kind: 'tool_use', text: json } as never).text).toBe(expected);
  });

  it('stays linear on 1 MiB of nested secret-named members', () => {
    const depth = 100_000;
    const deep = `${'{"secret":'.repeat(depth)}1${'}'.repeat(depth)}`;
    const started = performance.now();
    expect(scrubWireText(deep)).toBe('{"secret":"[REDACTED]"}');
    const wide = `{${Array.from({ length: 80_000 }, (_, index) => `"token${index}":${index}`).join(',')}}`;
    expect(scrubWireText(wide)).not.toMatch(/:\d/);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('placeholders are put back inside a streamed Gemini functionCall\'s args (review thread 4)', () => {
  it('restores args named url, name, id and data, and leaves kept keys outside args alone', () => {
    placeholders.maskText('DB_PASSWORD=hunter2abc1');
    const placeholder = placeholders.maskText('DB_PASSWORD=hunter2abc1').text.slice('DB_PASSWORD='.length);
    expect(placeholder).toMatch(/^\{\{SECRET_[a-z2-7]{8}\}\}$/);
    const event = (args: string, name: string) =>
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"${name}","args":${args}}}]}}]}\n\n`;
    const args = `{"url":"https://h/?k=${placeholder}","name":"${placeholder}","id":"${placeholder}","data":"${placeholder}","nested":{"items":[{"id":"${placeholder}"}]}}`;
    const stream = event(args, placeholder);
    const restorer = new PlaceholderRestoringResponse({ placeholders, contentType: 'text/event-stream', contentEncoding: null });
    const bytes = new TextEncoder().encode(stream);
    const output: Uint8Array[] = [];
    for (let index = 0; index < bytes.length; index += 5) output.push(...restorer.push(bytes.subarray(index, index + 5)));
    output.push(...restorer.finish());
    const restored = output.map(chunk => new TextDecoder().decode(chunk)).join('');
    const restoredArgs = `{"url":"https://h/?k=hunter2abc1","name":"hunter2abc1","id":"hunter2abc1","data":"hunter2abc1","nested":{"items":[{"id":"hunter2abc1"}]}}`;
    // functionCall.name is the vendor's own tool name, outside args: kept as written.
    expect(restored).toBe(event(restoredArgs, placeholder));
  });
});

describe('a stream with no content-type keeps streaming when its first chunk is a partial line start', () => {
  it('decides from the held first bytes, streams event by event, and restores placeholders', () => {
    const placeholder = placeholders.maskText('DB_PASSWORD=hunter2abc1').text.slice('DB_PASSWORD='.length);
    const firstEvent = `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${placeholder}"}\n\n`;
    const secondEvent = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
    const restorer = new PlaceholderRestoringResponse({ placeholders, contentType: null, contentEncoding: null });
    const encoder = new TextEncoder();
    const decode = (chunks: Uint8Array[]) => chunks.map(chunk => new TextDecoder().decode(chunk)).join('');
    expect(restorer.push(encoder.encode('ev'))).toEqual([]);
    expect(decode(restorer.push(encoder.encode(firstEvent.slice(2))))).toBe(firstEvent.replace(placeholder, 'hunter2abc1'));
    expect(decode(restorer.push(encoder.encode(secondEvent)))).toBe(secondEvent);
    expect(restorer.finish()).toEqual([]);
  });

  it('a short whole body with no content-type is still put back when the reply ends', () => {
    const placeholder = placeholders.maskText('DB_PASSWORD=hunter2abc1').text.slice('DB_PASSWORD='.length);
    const restorer = new PlaceholderRestoringResponse({ placeholders, contentType: null, contentEncoding: null });
    expect(restorer.push(new TextEncoder().encode(`{"a":"${placeholder}"}`))).toEqual([]);
    expect(restorer.finish().map(chunk => new TextDecoder().decode(chunk)).join('')).toBe('{"a":"hunter2abc1"}');
  });
});

describe('consent writes are serialized across processes (review thread 5)', () => {
  it('waits for a held consent lock instead of writing past it', async () => {
    setWireRecordingConsent(true, consentFilePath);
    const lockPath = `${consentFilePath}.lock`;
    writeFileSync(lockPath, 'another process');
    const writer = Bun.spawn(['bun', '-e', `
      const consent = await import(${JSON.stringify(recordingConsentModulePath)});
      consent.clearWireRecordings({ consentFilePath: ${JSON.stringify(consentFilePath)}, recordingsDirectory: ${JSON.stringify(recordingsDirectory)} });
    `], { stdout: 'pipe', stderr: 'pipe' });
    // While the lock is held (as by a concurrent `consent --off` between its
    // read and its write), the clear must not have read-modified-written.
    await Bun.sleep(700);
    expect(readWireRecordingConsentFile(consentFilePath)?.generation).toBe(1);
    // The other process writes its decision and lets go.
    writeFileSync(consentFilePath, JSON.stringify({ recording: false, generation: 2, decidedAt: 'x' }));
    rmSync(lockPath);
    expect(await writer.exited).toBe(0);
    const after = readWireRecordingConsentFile(consentFilePath);
    expect(after?.recording).toBe(false);
    expect(after?.generation).toBe(3);
  });

  it('never hands two writers the same generation', async () => {
    mkdirSync(testRoot, { recursive: true });
    const processCount = 6;
    const changesPerProcess = 20;
    const writers = Array.from({ length: processCount }, (_, writerIndex) => Bun.spawn(['bun', '-e', `
      const consent = await import(${JSON.stringify(recordingConsentModulePath)});
      const generations = [];
      for (let index = 0; index < ${changesPerProcess}; index++) {
        const result = index % 2 === ${writerIndex % 2}
          ? consent.clearWireRecordings({ consentFilePath: ${JSON.stringify(consentFilePath)}, recordingsDirectory: ${JSON.stringify(recordingsDirectory)} })
          : consent.setWireRecordingConsent(${writerIndex % 2 === 0}, ${JSON.stringify(consentFilePath)});
        generations.push(result.generation);
      }
      console.log(JSON.stringify(generations));
    `], { stdout: 'pipe', stderr: 'pipe' }));
    const generations: number[] = [];
    for (const writer of writers) {
      expect(await writer.exited).toBe(0);
      generations.push(...JSON.parse(await new Response(writer.stdout).text()));
    }
    expect(new Set(generations).size).toBe(processCount * changesPerProcess);
    expect(JSON.parse(readFileSync(consentFilePath, 'utf-8')).generation).toBe(processCount * changesPerProcess);
  }, 30_000);
});
