import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { OutboundRedactionPlaceholders } from '../../src/services/wire-gateway/privacy/outbound-redaction.js';
import { PlaceholderRestoringResponse } from '../../src/services/wire-gateway/privacy/placeholder-restoring-response.js';

// Ported from magpie internal/redact (MIT, Copyright (c) 2026 yetone):
// redact_test.go:97-244, restore_test.go, defs_test.go. claude-mem's outbound
// redaction masks secrets only, so magpie's personal-data and user-word cases
// are carried over with secrets in their place.

const testRoot = join(WIRE_GATEWAY_DIR, 'outbound-redaction-test');
const keyFilePath = join(testRoot, 'redact.key');

const openaiKey = 'sk-proj-abcdEFGH1234ijklMNOP5678qrst';
const ghToken = 'ghp_0123456789abcdefghijABCDEFGHIJ0123';
const placeholderPattern = /\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}/g;

/** `text` without its placeholders: a placeholder's hash can spell a short value a test checks is gone. */
function unmarked(text: string): string {
  return text.replace(placeholderPattern, '');
}

let placeholders: OutboundRedactionPlaceholders;

beforeEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  placeholders = new OutboundRedactionPlaceholders({ keyFilePath });
});
afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

function maskJson(body: string): { text: string; maskedCount: number } {
  const masked = placeholders.maskRequestBody(new TextEncoder().encode(body));
  return { text: new TextDecoder().decode(masked.bytes), maskedCount: masked.maskedCount };
}

/** Feed `allText` to a restorer `pieceSize` bytes at a time and collect what the agent gets. */
function restoreInPieces(allText: string, contentType: string, pieceSize: number): string {
  const restorer = new PlaceholderRestoringResponse({ placeholders, contentType, contentEncoding: null });
  const bytes = new TextEncoder().encode(allText);
  const output: Uint8Array[] = [];
  for (let index = 0; index < bytes.length; index += pieceSize) {
    output.push(...restorer.push(bytes.subarray(index, Math.min(index + pieceSize, bytes.length))));
  }
  output.push(...restorer.finish());
  return output.map(chunk => new TextDecoder().decode(chunk)).join('');
}

function eventDataOf(stream: string): string[] {
  return stream.split('\n\n').map(event => {
    const at = event.indexOf('data: ');
    return at < 0 ? null : event.slice(at + 'data: '.length);
  }).filter((data): data is string => data !== null && data !== '[DONE]');
}

describe('masking (magpie TestMask, secrets only)', () => {
  const cases: Array<{ input: string; gone?: string[]; kept?: string[]; count: number }> = [
    { input: `export OPENAI_API_KEY=${openaiKey}`, gone: [openaiKey], kept: ['export OPENAI_API_KEY='], count: 1 },
    { input: `token ${ghToken} and AKIAIOSFODNN7EXAMPLE`, gone: [ghToken, 'AKIAIOSFODNN7EXAMPLE'], count: 2 },
    { input: 'postgres://app:s3cretPass@db.internal:5432/app', gone: ['s3cretPass'], kept: ['postgres://app:', '@db.internal'], count: 1 },
    { input: 'postgres://app:${DB_PASS}@db/app', kept: ['${DB_PASS}'], count: 0 },
    { input: 'DB_PASSWORD="hunter2hunter2x9"', gone: ['hunter2hunter2x9'], count: 1 },
    { input: 'password = getPassword()', kept: ['getPassword()'], count: 0 },
    { input: 'the tokenizer splits words', kept: ['tokenizer'], count: 0 },
    { input: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', gone: ['MIIEow'], count: 1 },
    { input: 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl here', gone: ['eyJhbGciOiJIUzI1NiJ9'], count: 1 },
    { input: 'mail me: jane.doe@acme.io', kept: ['jane.doe@acme.io'], count: 0 },
  ];
  for (const testCase of cases) {
    it(`masks and restores ${JSON.stringify(testCase.input.slice(0, 40))}`, () => {
      const masked = placeholders.maskText(testCase.input);
      expect(masked.maskedCount).toBe(testCase.count);
      for (const gone of testCase.gone ?? []) expect(unmarked(masked.text)).not.toContain(gone);
      for (const kept of testCase.kept ?? []) expect(masked.text).toContain(kept);
      expect(placeholders.restore(masked.text, false)).toBe(testCase.input);
    });
  }

  it('gives the same value the same placeholder: {{KIND_<8 of lower base32 HMAC>}}', () => {
    const first = placeholders.maskText(`k=${openaiKey}`).text.match(placeholderPattern)?.[0];
    const second = placeholders.maskText(`other ${openaiKey}`).text.match(placeholderPattern)?.[0];
    expect(first).toMatch(/^\{\{API_KEY_[a-z2-7]{8}\}\}$/);
    expect(first).toBe(second);
  });

  it('keeps its key in redact.key (32 bytes, owner-only), so placeholders survive a restart', () => {
    const before = placeholders.placeholderFor('API_KEY', openaiKey);
    expect(readFileSync(keyFilePath).length).toBe(32);
    if (process.platform !== 'win32') expect(statSync(keyFilePath).mode & 0o777).toBe(0o600);
    const afterRestart = new OutboundRedactionPlaceholders({ keyFilePath });
    expect(afterRestart.placeholderFor('API_KEY', openaiKey)).toBe(before);
  });

  it('writes no key file until something is masked', () => {
    placeholders.maskText('nothing secret here');
    expect(existsSync(keyFilePath)).toBe(false);
  });

  it('lets the oldest half go when full, and a request that still has a value brings it back', () => {
    const small = new OutboundRedactionPlaceholders({ keyFilePath, maxHeldValues: 4 });
    const values = ['sk-aaaaaaaaaaaaaaaaaaaaaaa1', 'sk-bbbbbbbbbbbbbbbbbbbbbbb2', 'sk-ccccccccccccccccccccccc3', 'sk-ddddddddddddddddddddddd4', 'sk-eeeeeeeeeeeeeeeeeeeeeee5'];
    const firstPlaceholder = small.placeholderFor('API_KEY', values[0]);
    for (const value of values.slice(1)) small.placeholderFor('API_KEY', value);
    expect(small.heldValueCount).toBe(3);
    expect(small.restore(firstPlaceholder, false)).toBe(firstPlaceholder);
    small.maskText(`again ${values[0]}`);
    expect(small.restore(firstPlaceholder, false)).toBe(values[0]);
  });

  it('masks a value seen before wherever a request has it, whatever is around it (known values)', () => {
    placeholders.maskText('DB_PASSWORD=hunter2hunter2x9');
    const masked = placeholders.maskText('the password you gave, hunter2hunter2x9, works');
    expect(masked.maskedCount).toBe(1);
    expect(unmarked(masked.text)).not.toContain('hunter2hunter2x9');
  });
});

describe('maskRequestBody (magpie MaskJSON)', () => {
  it('masks text, keeps model/signature, and leaves every other byte as it was', () => {
    const body = `{"model":"sk-proj-notmasked-because-model-key","messages":[{"role":"user","content":[`
      + `{"type":"text","text":"key: ${openaiKey}\\nok"},`
      + `{"type":"thinking","thinking":"hm","signature":"${openaiKey}"}]}],"n":1,"stream":true}`;
    const masked = maskJson(body);
    expect(masked.maskedCount).toBe(1);
    expect(masked.text.split(openaiKey).length - 1).toBe(1);
    expect(() => JSON.parse(masked.text)).not.toThrow();
    expect(masked.text).toContain('"model":"sk-proj-notmasked-because-model-key"');
    expect(masked.text).toContain('\\nok"');
    expect(placeholders.restoreJsonText(masked.text)).toBe(body);

    const plain = '{ "a" : [1, 2.5e3, true, null, "xé"] }';
    const plainMasked = placeholders.maskRequestBody(new TextEncoder().encode(plain));
    expect(plainMasked.changed).toBe(false);
    expect(new TextDecoder().decode(plainMasked.bytes)).toBe(plain);
  });

  it('sends what a vendor sealed back as the vendor wrote it (values masked elsewhere become their placeholders again)', () => {
    const userKeyPlaceholder = placeholders.maskText(openaiKey).text;
    const agentView = `Its key is the one ending ${openaiKey}.`;
    const vendorWrote = `Its key is the one ending ${userKeyPlaceholder}.`;
    const userMessage = `{"role":"user","content":"key ${openaiKey}"}`;
    const bodies: Record<string, string> = {
      anthropic: `{"messages":[${userMessage},{"role":"assistant","content":[{"type":"thinking","thinking":"${agentView}","signature":"Eqk1"}]}]}`,
      gemini: `{"contents":[{"role":"user","parts":[{"text":"key ${openaiKey}"}]},{"role":"model","parts":[{"text":"${agentView}","thought":true,"thoughtSignature":"Cs4B"}]}]}`,
      'gemini call': `{"contents":[{"role":"user","parts":[{"text":"key ${openaiKey}"}]},{"role":"model","parts":[{"functionCall":{"name":"note","args":{"text":"${agentView}"}},"thoughtSignature":"Cs4B"}]}]}`,
      responses: `{"input":[${userMessage},{"type":"reasoning","summary":[{"type":"summary_text","text":"${agentView}"}],"encrypted_content":"gAAAA"}]}`,
    };
    for (const [name, body] of Object.entries(bodies)) {
      const masked = maskJson(body).text;
      expect({ name, sealedAsWritten: masked.includes(`"${vendorWrote}"`) }).toEqual({ name, sealedAsWritten: true });
      expect({ name, leaked: masked.includes(openaiKey) }).toEqual({ name, leaked: false });
    }
    // No signature: nothing sealed, so masked by the rules.
    const unsigned = maskJson(`{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"use DB_PASSWORD=hunter2abc1 now","signature":""}]}]}`).text;
    expect(unsigned).not.toContain('hunter2abc1');
  });

  it('never touches the text of a signature or other sealed value', () => {
    const body = `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"plain","signature":"DB_PASSWORD=hunter2abc1"}]}]}`;
    expect(maskJson(body).text).toBe(body);
  });

  it('keeps ids on both sides of what they match', () => {
    for (const key of ['id', 'tool_call_id', 'tool_use_id', 'call_id', 'approval_request_id', 'toolCallId']) {
      const body = `{"${key}":"${openaiKey}"}`;
      expect(maskJson(body).text).toBe(body);
    }
    expect(maskJson(`{"content":"key ${openaiKey}"}`).text).not.toContain(openaiKey);
  });

  it('masks a tool call\'s arguments whatever their keys are called (a "signature" key in args is still masked)', () => {
    const bodies: Record<string, string> = {
      'signature key': '{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"send_email","input":{"signature":"DB_PASSWORD=hunter2abc1","body":"Best, Bob"}}]}]}',
      'id keys': '{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"lookup","input":{"user_id":"DB_PASSWORD=hunter2abc1"}}]}]}',
      'gemini args': '{"contents":[{"role":"model","parts":[{"functionCall":{"name":"lookup","args":{"thoughtSignature":"x","customer_id":"DB_PASSWORD=hunter2abc1"}}}]}]}',
      'text block': '{"messages":[{"role":"user","content":[{"type":"text","text":"DB_PASSWORD=hunter2abc1","signature":"x"}]}]}',
    };
    for (const [name, body] of Object.entries(bodies)) {
      const masked = maskJson(body).text;
      expect({ name, leaked: masked.includes('hunter2abc1') }).toEqual({ name, leaked: false });
      if (body.includes('toolu_1')) expect(masked).toContain('"toolu_1"');
    }
  });

  it('masks only descriptions in what the agent defines for the vendor (tools, schemas, settings)', () => {
    const kept: Array<[string, string, string]> = [
      ['anthropic tools', `{"messages":[{"role":"user","content":"hi"}],"tools":[{"name":"t","description":"use ${openaiKey}","input_schema":{"type":"object","properties":{"mode":{"type":"string","enum":["${openaiKey}"]}}}}]}`, `"enum":["${openaiKey}"]`],
      ['chat response_format', `{"messages":[{"role":"user","content":"hi"}],"response_format":{"type":"json_schema","json_schema":{"name":"r","schema":{"type":"string","pattern":"${openaiKey}"}}}}`, `"pattern":"${openaiKey}"`],
      ['responses text.format', `{"input":"hi","text":{"format":{"type":"json_schema","name":"r","schema":{"enum":["${openaiKey}"]}}}}`, `"enum":["${openaiKey}"]`],
      ['responses additional_tools', `{"input":[{"type":"additional_tools","tools":[{"type":"function","name":"f","parameters":{"enum":["${openaiKey}"]}}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`, `"enum":["${openaiKey}"]`],
      ['gemini generationConfig', `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"responseSchema":{"type":"STRING","enum":["${openaiKey}"]}}}`, `"enum":["${openaiKey}"]`],
    ];
    for (const [name, body, keptText] of kept) {
      const masked = maskJson(body).text;
      expect({ name, kept: masked.includes(keptText) }).toEqual({ name, kept: true });
    }
    const anthropicTools = maskJson(kept[0][1]).text;
    expect(anthropicTools).not.toContain(`use ${openaiKey}`);

    const maskedElsewhere: Record<string, string> = {
      'tool_use input': `{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"t","input":{"tools":"${openaiKey}","text":{"enum":"${openaiKey}"}}}]}]}`,
      'message text': `{"messages":[{"role":"user","content":[{"type":"text","text":"${openaiKey}"}]}]}`,
      'completion text': `{"text":"${openaiKey}"}`,
      'responses message': `{"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"${openaiKey}"}],"tools":"${openaiKey}"}]}`,
    };
    for (const [name, body] of Object.entries(maskedElsewhere)) {
      expect({ name, leaked: maskJson(body).text.includes(openaiKey) }).toEqual({ name, leaked: false });
    }
  });

  it('masks a body that is not JSON as text', () => {
    const masked = maskJson(`not json ${openaiKey}`);
    expect(masked.maskedCount).toBe(1);
    expect(masked.text).not.toContain(openaiKey);
  });
});

describe('restoring (magpie Restore and Writer)', () => {
  it('puts back placeholders the model rewrote (mangled forms), and leaves what only looks like one', () => {
    const value = 'hunter2hunter2x9';
    const masked = placeholders.maskText(`DB_PASSWORD=${value}`).text;
    const placeholder = masked.slice(masked.indexOf('{{'));
    const body = placeholder.slice(2, -2); // API-style body, e.g. SECRET_xxxxxxxx
    const kindLength = body.length - 8;
    const lower = body.toLowerCase();
    const upper = body.slice(0, kindLength) + body.slice(kindLength).toUpperCase();
    const cases: Array<[string, string]> = [
      [`use ${placeholder} now`, `use ${value} now`],
      [`use {{ ${body} }} now`, `use ${value} now`],
      [`use {{${body}} now`, `use ${value} now`],
      [`use {${body}}} now`, `use ${value} now`],
      [`use {${body}} now`, `use ${value} now`],
      [`use {{${body} now`, `use ${value} now`],
      [`use${body}now`, `use${body}now`],
      [`use 我${body}好`, `use 我${value}好`],
      [`pw: \`${body}\``, `pw: \`${value}\``],
      [`use {{${lower}}} now`, `use ${value} now`],
      [`use {{${upper}}} now`, `use ${value} now`],
      [`{"to":"${body}"}`, `{"to":"${value}"}`],
      [`a {${body} b`, `a {${value} b`],
      [`{{SECRET_zzzzzzzz}} x${body} ${body}x`, `{{SECRET_zzzzzzzz}} x${body} ${body}x`],
    ];
    for (const [input, want] of cases) expect(placeholders.restore(input, false)).toBe(want);

    // JSON-escaped inside a tool call's arguments.
    const quoted = 'pa"ss\\word1234';
    const quotedPlaceholder = placeholders.placeholderFor('SECRET', quoted);
    const restoredArgs = placeholders.restore(`{"env":"{{ ${quotedPlaceholder.slice(2, -2).toLowerCase()} }}"}`, true);
    expect(JSON.parse(restoredArgs).env).toBe(quoted);
  });

  it('restores a placeholder split across 3 deltas, written 7 bytes at a time, with the event count unchanged', () => {
    const placeholder = placeholders.maskText(openaiKey).text;
    const tool = `{"cmd":"echo ${placeholder}"}`;
    const textEvent = (text: string) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`;
    const jsonEvent = (partial: string) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: partial } })}\n\n`;
    const events = [
      textEvent(`use ${placeholder.slice(0, 5)}`), textEvent(placeholder.slice(5, 12)), textEvent(`${placeholder.slice(12)} now {`),
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      jsonEvent(tool.slice(0, 14)), jsonEvent(tool.slice(14)), 'data: [DONE]\n\n',
    ];
    const output = restoreInPieces(events.join(''), 'text/event-stream', 7);

    let text = '';
    let partialJson = '';
    for (const data of eventDataOf(output)) {
      const event = JSON.parse(data) as { delta?: { text?: string; partial_json?: string } };
      text += event.delta?.text ?? '';
      partialJson += event.delta?.partial_json ?? '';
    }
    expect(text).toBe(`use ${openaiKey} now {`);
    expect(JSON.parse(partialJson).cmd).toBe(`echo ${openaiKey}`);
    expect(output.split('\n\n').length - 1).toBe(events.length);
  });

  it('restores a whole JSON reply and drops nothing', () => {
    const placeholder = placeholders.maskText(ghToken).text;
    const reply = JSON.stringify({ output: [
      { type: 'function_call', arguments: `{"t":"${placeholder}"}` },
      { type: 'message', content: [{ type: 'output_text', text: `got ${placeholder}` }] },
    ] });
    const output = restoreInPieces(reply, 'application/json', 5);
    expect(output).not.toContain('{{');
    expect(output).toContain(`got ${ghToken}`);
    expect(JSON.parse(JSON.parse(output).output[0].arguments).t).toBe(ghToken);
  });

  it('puts back a placeholder a model writes token by token in rewritten forms (Chat chunks)', () => {
    const value = 'hunter2hunter2x9';
    const masked = placeholders.maskText(`DB_PASSWORD=${value}`).text;
    const body = masked.slice(masked.indexOf('{{') + 2, -2);
    const kind = body.slice(0, -9);
    const hash = body.slice(-8);
    const chat = (content: string) => `data: {"id":"chatcmpl-9a1","object":"chat.completion.chunk","created":1760000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":${JSON.stringify(content)}},"logprobs":null,"finish_reason":null}]}\n\n`;
    const pieces = [
      'saved: ', '{{', ' ', kind.slice(0, 2), kind.slice(2), `_${hash.slice(0, 3)}`, hash.slice(3), ' ', '}}', '.\n',
      'spare ', kind.slice(0, 2), `${kind.slice(2)}_`, hash.slice(0, 4), hash.slice(4), ';',
      'again {{', body.slice(0, 4), body.slice(4), '}', '}', '.',
      'last ', body, '',
    ];
    const events = [
      ...pieces.map(chat),
      'data: {"id":"chatcmpl-9a1","object":"chat.completion.chunk","created":1760000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const restorer = new PlaceholderRestoringResponse({ placeholders, contentType: 'text/event-stream', contentEncoding: null });
    const output = [...events.flatMap(event => restorer.push(new TextEncoder().encode(event))), ...restorer.finish()]
      .map(chunk => new TextDecoder().decode(chunk)).join('');
    let text = '';
    for (const data of eventDataOf(output)) {
      text += (JSON.parse(data) as { choices: Array<{ delta: { content?: string } }> }).choices[0].delta.content ?? '';
    }
    expect(text).toBe(`saved: ${value}.\nspare ${value};again ${value}.last ${value}`);
    expect(output.split('\n\n').length - 1).toBe(events.length);
  });

  it('puts a lower-cased placeholder split inside partial_json back JSON-escaped', () => {
    const value = 'pa"ss\\word1234';
    const placeholder = placeholders.placeholderFor('SECRET', value).toLowerCase();
    const args = `{"file_path":"notes.md","content":"pw: ${placeholder}\\n"}`;
    const event = (partial: string) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: partial } })}\n\n`;
    const splitAt = args.indexOf(placeholder) + 9;
    const output = restoreInPieces(
      event(args.slice(0, splitAt)) + event(args.slice(splitAt)) + 'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'text/event-stream', 64);
    let partialJson = '';
    for (const data of eventDataOf(output)) partialJson += (JSON.parse(data) as { delta?: { partial_json?: string } }).delta?.partial_json ?? '';
    expect(JSON.parse(partialJson).content).toBe(`pw: ${value}\n`);
  });

  it('leaves a compressed reply as it is', () => {
    const restorer = new PlaceholderRestoringResponse({ placeholders, contentType: 'application/json', contentEncoding: 'gzip' });
    expect(restorer.passesThrough).toBe(true);
    const bytes = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);
    expect(restorer.push(bytes)).toEqual([bytes]);
  });
});
