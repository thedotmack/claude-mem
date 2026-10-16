import { describe, expect, it } from 'bun:test';
import { parseWireRequest } from '../../src/services/wire-gateway/ir/request-parsers.js';
import type { WireRequest } from '../../src/services/wire-gateway/ir/types.js';
import type { WireIdentity } from '../../src/services/wire-gateway/identity/resolve-identity.js';
import { ledgerEntryIdOf, type WireConversationLedgerView, type WireLedgerEntry } from '../../src/services/wire-gateway/ledger/conversation-ledger.js';
import {
  EVENT_STAGE_BUDGET_MS,
  REQUEST_STAGE_BUDGET_MS,
  WireRewriteSeam,
  WireRewriteStageHealth,
  callWithinBudget,
  type WireRewriteContextBase,
  type WireRewriteStage,
} from '../../src/services/wire-gateway/rewrite/rewrite-stage.js';
import { ResponseStageTransform } from '../../src/services/wire-gateway/rewrite/response-stage-transform.js';
import { toolPairingProblem, unpairedToolPartsOf } from '../../src/services/wire-gateway/rewrite/tool-pairing.js';
import type { WireGatewayRoute } from '../../src/services/wire-gateway/routes.js';

// Phase 10 tasks 1 and 4: stages chain, fail open (throw, spin past the
// budget, bad return), reject; the reply side runs per event or per whole
// reply; the pairing check refuses a rewrite that breaks a tool pair.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesOf = (text: string) => encoder.encode(text);
const textOf = (bytes: Uint8Array) => decoder.decode(bytes);

const route: WireGatewayRoute = { agentId: 'claude-code', upstreamBaseUrl: 'http://127.0.0.1:1', captureSource: 'wire', features: {}, createdAt: '2026-10-15T00:00:00.000Z' };
const identity: WireIdentity = { agentId: 'claude-code', sessionId: 's1', sessionSource: 'header', kind: 'turn', userWords: 'hi', userTurnOrdinal: 1, turnStart: true };

function contextBase(): WireRewriteContextBase {
  return {
    routeId: 'r1',
    route,
    identity,
    ledger: null,
    protocol: 'anthropic',
    settings: {},
    requestOf: body => parseWireRequest('anthropic', body),
  };
}

function seamOf(...stages: WireRewriteStage[]) {
  const health = new WireRewriteStageHealth();
  return { seam: new WireRewriteSeam({ stages, health }), health };
}

const original = bytesOf('{"model":"m","messages":[{"role":"user","content":"hi"}]}');
const appendingStage = (name: string, suffix: string): WireRewriteStage => ({
  name,
  onRequest: (_context, body) => bytesOf(textOf(body).replace(/"hi[^"]*"/, match => `${match.slice(0, -1)}${suffix}"`)),
});

function spin(milliseconds: number): void {
  const until = performance.now() + milliseconds;
  while (performance.now() < until) { /* spin */ }
}

describe('request stages', () => {
  it('chain in order, each given what the one before returned', async () => {
    const { seam } = seamOf(appendingStage('first', '+1'), appendingStage('second', '+2'));
    const outcome = await seam.begin(contextBase())!.runRequestStages(original);
    expect(textOf(outcome.body)).toContain('"hi+1+2"');
    expect(outcome.appliedStageNames).toEqual(['first', 'second']);
    expect(outcome.rejection).toBeNull();
  });

  it('keep the exact bytes when a stage returns undefined or the same buffer', async () => {
    const { seam } = seamOf({ name: 'noop', onRequest: () => undefined }, { name: 'same', onRequest: (_context, body) => body });
    const outcome = await seam.begin(contextBase())!.runRequestStages(original);
    expect(outcome.body).toBe(original);
    expect(outcome.appliedStageNames).toEqual([]);
  });

  it('is skipped entirely when no stage applies (no run at all)', () => {
    expect(seamOf().seam.begin(contextBase())).toBeNull();
    expect(seamOf({ name: 'off', appliesTo: () => false, onRequest: () => bytesOf('{}') }).seam.begin(contextBase())).toBeNull();
  });

  it('fails open when a stage throws, and the next stage still runs', async () => {
    const { seam, health } = seamOf({ name: 'thrower', onRequest: () => { throw new Error('boom'); } }, appendingStage('after', '!'));
    const outcome = await seam.begin(contextBase())!.runRequestStages(original);
    expect(textOf(outcome.body)).toContain('"hi!"');
    expect(health.states().thrower).toMatchObject({ failures: 1, lastError: 'onRequest: boom' });
  });

  it('fails open when a synchronous stage spins past its budget', async () => {
    const { seam, health } = seamOf({ name: 'spinner', budgetMs: 20, onRequest: (_context, body) => { spin(60); return bytesOf(textOf(body).replace('hi', 'spun')); } });
    const outcome = await seam.begin(contextBase())!.runRequestStages(original);
    expect(outcome.body).toBe(original);
    expect(health.states().spinner.failures).toBe(1);
    expect(health.states().spinner.lastError).toContain('budget');
  });

  it('fails open on time when an async stage outlasts its budget', async () => {
    const { seam, health } = seamOf({ name: 'slow', budgetMs: 30, onRequest: () => new Promise(resolve => setTimeout(() => resolve(bytesOf('{"late":true}')), 2_000)) });
    const startedAt = performance.now();
    const outcome = await seam.begin(contextBase())!.runRequestStages(original);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(outcome.body).toBe(original);
    expect(health.states().slow.failures).toBe(1);
  });

  it('fails open on a bad return: not bytes, not JSON', async () => {
    const { seam, health } = seamOf(
      { name: 'string', onRequest: () => '{"x":1}' as unknown as Uint8Array },
      { name: 'garbage', onRequest: () => bytesOf('{"unterminated') },
    );
    const outcome = await seam.begin(contextBase())!.runRequestStages(original);
    expect(outcome.body).toBe(original);
    expect(health.states().string.failures).toBe(1);
    expect(health.states().garbage.failures).toBe(1);
  });

  it('takes back a failed stage\'s estimates', async () => {
    const { seam } = seamOf(
      { name: 'counted', onRequest: context => { context.estimates.injectedTokens += 10; return undefined; } },
      { name: 'failing', onRequest: context => { context.estimates.injectedTokens += 99; throw new Error('no'); } },
    );
    const run = seam.begin(contextBase())!;
    await run.runRequestStages(original);
    expect(run.estimates.injectedTokens).toBe(10);
  });

  it('stops at the first rejection, with its status kept in 400–599', async () => {
    const { seam } = seamOf(
      { name: 'rejecter', onRequest: () => ({ reject: { status: 451, message: 'not today' } }) },
      { name: 'never', onRequest: () => { throw new Error('ran after a rejection'); } },
    );
    const outcome = await seam.begin(contextBase())!.runRequestStages(original);
    expect(outcome.rejection).toEqual({ status: 451, message: 'not today' });
    expect(outcome.body).toBe(original);
    const defaulted = await seamOf({ name: 'r', onRequest: () => ({ reject: { status: 200 } }) }).seam.begin(contextBase())!.runRequestStages(original);
    expect(defaulted.rejection?.status).toBe(403);
  });

  it('gives each stage its own state and a parse of the body it is handed', async () => {
    const seen: string[] = [];
    const { seam } = seamOf(
      { name: 'a', onRequest: (context, body) => { context.state.mine = 'a'; seen.push(context.requestOf(body).model); return bytesOf(textOf(body).replace('"m"', '"m2"')); } },
      { name: 'b', onRequest: (context, body) => { seen.push(String(context.state.mine)); seen.push(context.requestOf(body).model); return undefined; } },
    );
    await seam.begin(contextBase())!.runRequestStages(original);
    expect(seen).toEqual(['m', 'undefined', 'm2']);
  });

  it('has the budgets of magpie: 250 ms a request, 50 ms an event', async () => {
    expect(REQUEST_STAGE_BUDGET_MS).toBe(250);
    expect(EVENT_STAGE_BUDGET_MS).toBe(50);
    await expect(callWithinBudget(() => 7, 10)).resolves.toBe(7);
  });
});

const anthropicStream = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
  'event: ping\ndata: {"type":"ping"}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
  ': a comment\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

async function streamThrough(transform: ResponseStageTransform, chunks: string[]): Promise<string> {
  const out: Uint8Array[] = [];
  for (const chunk of chunks) out.push(...await transform.push(bytesOf(chunk)));
  out.push(...await transform.finish(true));
  return out.map(textOf).join('');
}

/** A born conversation's ledger that keeps what reaches it in `written`. */
function bornLedger(): WireConversationLedgerView & { written: WireLedgerEntry[] } {
  const written: WireLedgerEntry[] = [{ type: 'born', at: '2026-10-15T00:00:00.000Z' }];
  return {
    written,
    conversationKey: 'k',
    status: 'born',
    get: entryId => written.find(entry => ledgerEntryIdOf(entry) === entryId),
    entries: () => [...written],
    record(entry) {
      const existing = this.get(ledgerEntryIdOf(entry));
      if (existing) return existing;
      written.push(entry);
      return entry;
    },
  };
}

describe('ledger writes during request stages', () => {
  const recordingStage = (name: string, callId: string, after: () => unknown = () => undefined): WireRewriteStage => ({
    name,
    onRequest: context => {
      context.ledger!.record({ type: 'swap', callId, replacementText: 'x', firstRequestAt: 't' });
      return after() as undefined;
    },
  });

  it('are held until committed, and seen by later stages meanwhile', async () => {
    const ledger = bornLedger();
    let seenByLater: WireLedgerEntry | undefined;
    const { seam } = seamOf(recordingStage('first', 'c1'), { name: 'later', onRequest: context => { seenByLater = context.ledger!.get('swap:c1'); return undefined; } });
    const run = seam.begin({ ...contextBase(), ledger })!;
    await run.runRequestStages(original);
    expect(seenByLater).toMatchObject({ callId: 'c1' });
    expect(ledger.written).toHaveLength(1);
    run.commitLedgerEntries();
    expect(ledger.written.map(ledgerEntryIdOf)).toEqual(['born', 'swap:c1']);
  });

  it('are dropped when the original bytes go instead', async () => {
    const ledger = bornLedger();
    const run = seamOf(recordingStage('first', 'c1')).seam.begin({ ...contextBase(), ledger })!;
    await run.runRequestStages(original);
    run.discardLedgerEntries();
    expect(ledger.written).toHaveLength(1);
  });

  it('are dropped for a stage that failed, kept for one that did not', async () => {
    const ledger = bornLedger();
    const { seam } = seamOf(recordingStage('kept', 'c1'), recordingStage('thrower', 'c2', () => { throw new Error('boom'); }));
    const run = seam.begin({ ...contextBase(), ledger })!;
    await run.runRequestStages(original);
    run.commitLedgerEntries();
    expect(ledger.written.map(ledgerEntryIdOf)).toEqual(['born', 'swap:c1']);
  });

  it('are refused from a stage left behind past its budget', async () => {
    const ledger = bornLedger();
    let lateWrite: Promise<unknown> = Promise.resolve();
    const { seam } = seamOf({
      name: 'late',
      budgetMs: 20,
      onRequest: context => new Promise(resolve => {
        lateWrite = new Promise(done => setTimeout(() => {
          try {
            context.ledger!.record({ type: 'thinkingDrop', boundaryMessageIndex: 3 });
            done('recorded');
          } catch (error) {
            done((error as Error).message);
          }
          resolve(undefined);
        }, 80));
      }),
    });
    const run = seam.begin({ ...contextBase(), ledger })!;
    await run.runRequestStages(original);
    run.commitLedgerEntries();
    expect(await lateWrite).toContain('records nothing more');
    expect(ledger.written).toHaveLength(1);
  });
});

describe('response stages', () => {
  it('rewrite, drop or keep each event, other bytes untouched', async () => {
    const { seam } = seamOf({
      name: 'events',
      onEvent: (_context, event) => {
        if (event.name === 'ping') return null;
        if (event.name === 'content_block_delta') return { name: event.name, dataJson: event.dataJson.replace('hello', 'HELLO') };
        return undefined;
      },
    });
    const transform = new ResponseStageTransform({ run: seam.begin(contextBase())!, status: 200, contentType: 'text/event-stream', contentEncoding: null });
    // Split across odd chunk boundaries.
    const joined = anthropicStream.join('');
    const chunks = [joined.slice(0, 7), joined.slice(7, 90), joined.slice(90, 91), joined.slice(91)];
    const out = await streamThrough(transform, chunks);
    expect(out).toBe(joined.replace('event: ping\ndata: {"type":"ping"}\n\n', '').replace('hello', 'HELLO'));
  });

  it('keeps an event as it came when its stage fails, and passes the rest', async () => {
    const { seam, health } = seamOf({ name: 'broken', onEvent: () => { throw new Error('bad event'); } });
    const transform = new ResponseStageTransform({ run: seam.begin(contextBase())!, status: 200, contentType: 'text/event-stream', contentEncoding: null });
    expect(await streamThrough(transform, anthropicStream)).toBe(anthropicStream.join(''));
    expect(health.states().broken.failures).toBe(4); // every event with JSON data; the comment has none
  });

  it('runs onResponse on a whole JSON reply, and not on a cut one', async () => {
    const { seam } = seamOf({ name: 'whole', onResponse: (_context, body) => bytesOf(textOf(body).replace('ok', 'OK')) });
    const transform = new ResponseStageTransform({ run: seam.begin(contextBase())!, status: 200, contentType: 'application/json', contentEncoding: null });
    expect(await transform.push(bytesOf('{"text":'))).toEqual([]);
    expect(await transform.push(bytesOf('"ok"}'))).toEqual([]);
    expect((await transform.finish(true)).map(textOf).join('')).toBe('{"text":"OK"}');

    const cut = new ResponseStageTransform({ run: seam.begin(contextBase())!, status: 200, contentType: 'application/json', contentEncoding: null });
    await cut.push(bytesOf('{"text":"ok'));
    expect((await cut.finish(false)).map(textOf).join('')).toBe('{"text":"ok');
  });

  it('passes an encoded reply, or a reply no stage reads, as it is', () => {
    const { seam } = seamOf({ name: 'whole', onResponse: () => undefined });
    expect(new ResponseStageTransform({ run: seam.begin(contextBase())!, status: 200, contentType: 'application/json', contentEncoding: 'gzip' }).passesThrough).toBe(true);
    expect(new ResponseStageTransform({ run: seam.begin(contextBase())!, status: 200, contentType: 'text/event-stream', contentEncoding: null }).passesThrough).toBe(true);
  });

  it('frames CRLF events, comments and split UTF-8 fed one byte at a time, unchanged bytes kept exactly', async () => {
    const { seam } = seamOf({
      name: 'events',
      onEvent: (_context, event) => (event.name === 'delta' ? { name: event.name, dataJson: event.dataJson.replace('é', 'É') } : undefined),
    });
    const transform = new ResponseStageTransform({ run: seam.begin(contextBase())!, status: 200, contentType: 'text/event-stream', contentEncoding: null });
    const stream = ': keep-alive\r\n\r\nevent: delta\r\ndata: {"t":"café 漢\\u00e9"}\r\n\r\nevent: other\r\ndata: {"t":"漢"}\r\n\r\n';
    const out: Uint8Array[] = [];
    for (const byte of bytesOf(stream)) out.push(...await transform.push(Uint8Array.of(byte)));
    out.push(...await transform.finish(true));
    expect(textOf(Buffer.concat(out))).toBe(stream.replace('café', 'cafÉ'));
  });

  it('splits an event with a hostile 1 MB run of carriage returns in linear time', async () => {
    const { seam } = seamOf({ name: 'events', onEvent: () => undefined });
    const transform = new ResponseStageTransform({ run: seam.begin(contextBase())!, status: 200, contentType: 'text/event-stream', contentEncoding: null });
    const event = `event: x${'\r'.repeat(1_000_000)}y\ndata: {"a":1}${'\r'.repeat(1_000_000)}z\n\n`;
    const startedAt = performance.now();
    expect(await streamThrough(transform, [event])).toBe(event);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it('lets go of a reply too large to hold', async () => {
    const { seam } = seamOf({ name: 'whole', onResponse: () => bytesOf('{"never":true}') });
    const transform = new ResponseStageTransform({ run: seam.begin(contextBase())!, status: 200, contentType: 'application/json', contentEncoding: null, maxHeldBytes: 8 });
    const out = [...await transform.push(bytesOf('{"a":')), ...await transform.push(bytesOf('"0123456789"}')), ...await transform.finish(true)];
    expect(out.map(textOf).join('')).toBe('{"a":"0123456789"}');
  });
});

describe('pairing check', () => {
  const parse = (json: unknown): WireRequest => parseWireRequest('anthropic', bytesOf(JSON.stringify(json)));
  const pairedRequest = {
    model: 'm',
    messages: [
      { role: 'user', content: 'read' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a' }, { type: 'tool_result', tool_use_id: 't2', content: 'b' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: {} }] },
    ],
  };

  it('accepts a rewrite that keeps every pair (a waiting call stays allowed)', () => {
    const swapped = structuredClone(pairedRequest);
    (swapped.messages[2].content as Array<{ content: string }>)[0].content = '[claude-mem: replaced]';
    expect(unpairedToolPartsOf(parse(pairedRequest)).callsWithoutResult.get('t3')).toBe(1);
    expect(toolPairingProblem(parse(pairedRequest), parse(swapped))).toBeNull();
  });

  it('refuses a rewrite that drops a result, or a call', () => {
    const withoutResult = structuredClone(pairedRequest);
    (withoutResult.messages[2].content as unknown[]).splice(1, 1);
    expect(toolPairingProblem(parse(pairedRequest), parse(withoutResult))).toBe('tool call "t2" lost its result');
    const withoutCall = structuredClone(pairedRequest);
    (withoutCall.messages[1].content as unknown[]).splice(0, 1);
    expect(toolPairingProblem(parse(pairedRequest), parse(withoutCall))).toBe('tool result "t1" lost its call');
  });
});
