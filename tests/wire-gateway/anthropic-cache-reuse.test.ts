import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { addWireGatewayRoute } from '../../src/services/wire-gateway/routes.js';
import { WireConversationLedger } from '../../src/services/wire-gateway/ledger/conversation-ledger.js';
import { WireObservationLookup, type WireToolObservation, type WireToolObservationQuery } from '../../src/services/wire-gateway/endless/observation-lookup.js';
import { timelineBlockTextsOf, timelineRowsBlockText } from '../../src/services/wire-gateway/endless/endless-mode-stage.js';
import { TIMELINE_CLOSE_TAG } from '../../src/services/wire-gateway/identity/user-words.js';
import { ANTHROPIC_MAX_CACHE_BREAKPOINTS, withHeadCacheBreakpoint } from '../../src/services/wire-gateway/header/head-cache-breakpoint-stage.js';
import { AnthropicPromptCacheModel, type CacheRead } from './helpers/anthropic-cache-model.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';

// Which cache entries each request can reuse (Anthropic's rules, modelled in
// helpers/anthropic-cache-model.ts), for a Claude Code shaped conversation
// sent through the gateway with Endless Mode and memory injection on. The
// timeline is the first message and grows only at its end, so each fold must
// read everything through the timeline's previous end from the cache.

const testRoot = join(WIRE_GATEWAY_DIR, 'anthropic-cache-reuse-test');
const routesFilePath = join(testRoot, 'routes.json');
const ledgerDirectory = join(testRoot, 'ledger');
const decoder = new TextDecoder();
const ROUTE_ID = 'cache-reuse-anthropic';
const TIMELINE_TEXT = '# claude-mem\n- #12 an earlier observation';

const observationsByToolUseId = new Map<string, WireToolObservation[]>();
async function fakeFetchToolObservations(query: WireToolObservationQuery): Promise<Map<string, WireToolObservation[]>> {
  const found = new Map<string, WireToolObservation[]>();
  for (const toolUseId of query.toolUseIds) {
    const observation = observationsByToolUseId.get(toolUseId);
    if (observation) found.set(toolUseId, observation);
  }
  return found;
}

let upstream: FakeUpstream;
let gateway: StartedWireGateway;

beforeAll(async () => {
  rmSync(testRoot, { recursive: true, force: true });
  upstream = await startFakeUpstream({ kind: 'json', body: { ok: true } });
  addWireGatewayRoute({
    routeId: ROUTE_ID, agentId: 'claude-code', upstreamBaseUrl: upstream.url, captureSource: 'native',
    features: { endlessMode: true, memoryInjection: true },
  }, routesFilePath);
  gateway = await startWireGatewayForTest({
    routesFilePath,
    routesReloadCheckIntervalMs: 0,
    rewriteSettings: { CLAUDE_MEM_WIRE_GATEWAY_CONTEXT_TIMEOUT_MS: '200' },
    observationLookup: new WireObservationLookup({ fetchToolObservations: fakeFetchToolObservations, missBackoffBaseMs: 0 }),
    conversationLedger: new WireConversationLedger({ directory: ledgerDirectory }),
    memory: { injection: { fetchContext: async () => TIMELINE_TEXT } },
  });
});

afterAll(async () => {
  await gateway?.stop();
  await upstream?.stop();
  rmSync(testRoot, { recursive: true, force: true });
});

async function send(body: string, session: string): Promise<string> {
  const before = upstream.requests.length;
  const response = await fetch(`${gateway.baseUrl}/r/${ROUTE_ID}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', 'x-claude-mem-session': session },
    body,
  });
  await response.arrayBuffer();
  expect(response.status).toBe(200);
  expect(upstream.requests.length).toBe(before + 1);
  return decoder.decode(upstream.requests.at(-1)!.body);
}

type Message = { role: string; content: unknown };
const ONE_HOUR = { type: 'ephemeral', ttl: '1h' };

/**
 * A body the way Claude Code 2.1.310 sends one (Phase 6 tee'd bodies): 1-hour
 * breakpoints on system[1], system[2] and the last message's last block, a
 * system note after every user message and tool result, thinking on.
 */
function claudeCodeBody(messages: Message[]): string {
  const last = messages[messages.length - 1];
  const lastBlocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content as Array<Record<string, unknown>>;
  const marked = { ...last, content: [...lastBlocks.slice(0, -1), { ...lastBlocks[lastBlocks.length - 1], cache_control: ONE_HOUR }] };
  return JSON.stringify({
    model: 'claude-opus-5-5',
    messages: [...messages.slice(0, -1), marked],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.310;' },
      { type: 'text', text: 'You are a Claude agent.', cache_control: ONE_HOUR },
      { type: 'text', text: 'Long system prompt. '.repeat(50), cache_control: ONE_HOUR },
    ],
    tools: [{ name: 'Read', description: 'Reads a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
  });
}

const note = (left: number): Message => ({ role: 'system', content: `<total_tokens>${left} tokens left</total_tokens>` });

/**
 * Sends a Claude Code shaped conversation through the gateway, one turn per
 * entry of `turnsUseTools` (true: one tool call whose observation exists by
 * the next turn start; false: an answer with no tool), and models what each
 * forwarded request reads from the cache.
 */
async function runConversation(session: string, turnsUseTools: boolean[], lateObservationByTurn: Map<number, number> = new Map()) {
  const cache = new AnthropicPromptCacheModel();
  const history: Message[] = [];
  const turnStartRequestIndexes: number[] = [];
  const forwarded: string[] = [];
  const reads: CacheRead[] = [];
  const sendAndModel = async () => {
    const sent = await send(claudeCodeBody(history), session);
    forwarded.push(sent);
    reads.push(cache.send(sent));
    // Let the background observation lookups this request asked for finish.
    await new Promise(resolve => setTimeout(resolve, 20));
  };
  // turn → the turn before whose start its observation lands (a late observer), instead of the next one.
  const lateObservations: Array<{ releaseBeforeTurn: number; callId: string; observation: WireToolObservation }> = [];
  for (const [index, usesTool] of turnsUseTools.entries()) {
    const turn = index + 1;
    for (const late of lateObservations.filter(late => late.releaseBeforeTurn === turn)) observationsByToolUseId.set(late.callId, [late.observation]);
    history.push({ role: 'user', content: turn === 1 ? `<cwd>/work/app</cwd> task ${turn}` : `task ${turn}` }, note(15_000_000));
    turnStartRequestIndexes.push(forwarded.length);
    await sendAndModel();
    if (index === turnsUseTools.length - 1) break;
    if (usesTool) {
      const callId = `toolu_${session}_${turn}`;
      history.push(
        { role: 'assistant', content: [{ type: 'thinking', thinking: `think ${turn}`, signature: `sig-${turn}` }, { type: 'tool_use', id: callId, name: 'Read', input: { path: `/work/app/f${turn}` } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: `contents of f${turn} `.repeat(40) }] },
        note(14_999_000),
      );
      await sendAndModel();
      const observation = { observationId: 700 + turn, row: `#${700 + turn} 3:04p 🔵 Read f${turn}` };
      const releaseBeforeTurn = lateObservationByTurn.get(turn);
      if (releaseBeforeTurn === undefined) observationsByToolUseId.set(callId, [observation]);
      else lateObservations.push({ releaseBeforeTurn, callId, observation });
    }
    history.push({ role: 'assistant', content: [{ type: 'thinking', thinking: `wrap ${turn}`, signature: `sig-wrap-${turn}` }, { type: 'text', text: `done ${turn}` }] });
  }
  return { forwarded, reads, turnStartRequestIndexes };
}

/** The label of the timeline's last rows block in a sent body (messages[0], the block before its closing one). */
function timelineEndLabelOf(sent: string): string {
  const first = (JSON.parse(sent) as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0];
  return `messages[0][${first.content.findIndex(block => block.text === TIMELINE_CLOSE_TAG) - 1}]`;
}

describe('Anthropic cache reuse through the gateway', () => {
  it('each growth of the timeline reads everything through its previous end from the cache, and writes only what follows', async () => {
    const session = 'cache-reuse-claude-code';
    const TURNS = 5;
    const { forwarded, reads, turnStartRequestIndexes } = await runConversation(session, Array.from({ length: TURNS }, () => true));

    for (let turn = 2; turn <= TURNS; turn++) {
      const foldRequest = turnStartRequestIndexes[turn - 1];
      // The turn start folded the previous turn: its rows are the timeline's newest block, its tool call is gone.
      const blocks = (JSON.parse(forwarded[foldRequest]) as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0].content;
      expect(blocks.at(-2)!.text).toBe(timelineRowsBlockText([`U: ${turn === 2 ? "<cwd>/work/app</cwd> " : ""}task ${turn - 1}`, `#${700 + turn - 1} 3:04p 🔵 Read f${turn - 1}`, `A: done ${turn - 1}`]));
      expect(forwarded[foldRequest]).not.toContain(`toolu_${session}_${turn - 1}`);
      // It reads through the timeline's previous end: the entry the request before it wrote there.
      expect(reads[foldRequest].readThrough).toBe(timelineEndLabelOf(forwarded[foldRequest - 1]));
      expect(reads[foldRequest].entryWrittenByRequest).not.toBeNull();
      // The bytes through that end are the same (markers aside, which the cache does not count).
      const unmarked = (body: string) => body.replace(/,"cache_control":\{[^}]*\}/g, '');
      const closing = `,{"type":"text","text":${JSON.stringify(TIMELINE_CLOSE_TAG)}}`;
      const previous = unmarked(forwarded[foldRequest - 1]);
      expect(unmarked(forwarded[foldRequest]).startsWith(previous.slice(0, previous.indexOf(closing)))).toBe(true);
    }

    for (const [index, sent] of forwarded.entries()) {
      const body = JSON.parse(sent) as { system: Array<Record<string, unknown>>; messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
      // The session-start rows open the timeline, the first message; the system prompt is the agent's alone.
      expect(body.system).toHaveLength(3);
      expect(body.messages[0].role).toBe('user');
      expect(body.messages[0].content[0].text).toBe(timelineBlockTextsOf(`<claude-mem-context>\n${TIMELINE_TEXT}\n</claude-mem-context>`, [])[0]);
      // The gateway's breakpoint is on the timeline's last rows block, 1-hour like Claude Code's after it; four in all.
      expect(body.messages[0].content.at(-2)!.cache_control).toEqual(ONE_HOUR);
      expect(sent.split('"cache_control"').length - 1).toBe(ANTHROPIC_MAX_CACHE_BREAKPOINTS);
      expect(reads[index].writes).toContain(timelineEndLabelOf(sent));
      if (index > 0) expect(reads[index].readThrough).not.toBeNull();
    }
  });

  it('after a turn with no tool, each turn start still reads through the timeline\'s previous end', async () => {
    const session = 'cache-reuse-no-tool-turn';
    const { forwarded, reads, turnStartRequestIndexes } = await runConversation(session, [false, true, true]);
    for (const turn of [2, 3]) {
      const turnStart = turnStartRequestIndexes[turn - 1];
      expect(reads[turnStart].readThrough).toBe(timelineEndLabelOf(forwarded[turnStart - 1]));
    }
  });
});

describe('Anthropic cache reuse when a fold is refused or late', () => {
  it('with thinking on, a turn start that cannot fold reads everything the request before it wrote, and cuts nothing', async () => {
    // Turn 2's observation lands only before turn 4's start: turn 3's start cannot fold turn 2 (and so nothing after it).
    const session = 'cache-reuse-late-fold';
    const TURNS = 5;
    const { forwarded, reads, turnStartRequestIndexes } = await runConversation(session, Array.from({ length: TURNS }, () => true), new Map([[2, 4]]));
    const blocksOf = (sent: string) => (JSON.parse(sent) as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0].content.length;
    const turn3Start = turnStartRequestIndexes[2];
    const turn4Start = turnStartRequestIndexes[3];
    // Turn 3's start: no fold, so the timeline is as before, and every byte the request before it sent is a prefix of it
    // (markers aside): turn 2's tool work and its thinking go as Claude Code sent them.
    expect(blocksOf(forwarded[turn3Start])).toBe(blocksOf(forwarded[turn3Start - 1]));
    expect(forwarded[turn3Start]).toContain(`toolu_${session}_2`);
    expect(forwarded[turn3Start]).toContain('"signature":"sig-2"');
    expect(forwarded[turn3Start]).toContain('"signature":"sig-wrap-2"');
    const messagesUnmarked = (sent: string) => (JSON.parse(sent.replace(/,"cache_control":\{[^}]*\}/g, '')) as { messages: unknown[] }).messages;
    const previousMessages = messagesUnmarked(forwarded[turn3Start - 1]);
    // (Its last message is compared by the cache model below: Claude Code sends the marked last message in block form.)
    expect(messagesUnmarked(forwarded[turn3Start]).slice(0, previousMessages.length - 1)).toEqual(previousMessages.slice(0, -1));
    // So it reads the entry the request before it wrote at its last block: nothing before the new turn is written again.
    expect(reads[turn3Start].entryWrittenByRequest).toBe(turn3Start - 1);
    expect(reads[turn3Start].readThrough).toBe(reads[turn3Start - 1].writes.at(-1)!);
    // Turn 4's start: the late observation lands, turns 2 and 3 fold in one growth, read through the timeline's previous end.
    expect(blocksOf(forwarded[turn4Start])).toBe(blocksOf(forwarded[turn4Start - 1]) + 1);
    expect(forwarded[turn4Start]).not.toContain(`toolu_${session}_2`);
    expect(forwarded[turn4Start]).not.toContain('"type":"thinking"');
    expect(reads[turn4Start].readThrough).toBe(timelineEndLabelOf(forwarded[turn4Start - 1]));
    // Every other request reads at least through the timeline's end, and a request that does not fold reads all the request before it wrote.
    for (let index = 1; index < forwarded.length; index++) {
      if (blocksOf(forwarded[index]) === blocksOf(forwarded[index - 1])) {
        expect(reads[index].entryWrittenByRequest, `request ${index}`).toBe(index - 1);
      }
    }
  });
});

describe('the Anthropic cache model', () => {
  const system = [{ type: 'text', text: 'system', cache_control: ONE_HOUR }];
  const body = (messages: Message[]) => JSON.stringify({ system, messages });
  const marked = (text: string): Message => ({ role: 'system', content: [{ type: 'text', text, cache_control: ONE_HOUR }] });
  const turnStart = [{ role: 'user', content: 'task 1' }, marked('note')];
  /** The turn-start request's last message as later requests send it: the same block, its marker moved on. */
  const unmarkedNote: Message = { role: 'system', content: 'note' };
  const lines = '<claude-mem-timeline>\n#1 3:04p 🔵 Read f1\n</claude-mem-timeline>';

  it('lines appended to the turn\'s user message lose the turn-start entry; lines at the cull point keep it', () => {
    const appended = new AnthropicPromptCacheModel();
    appended.send(body(turnStart));
    const appendedRead = appended.send(body([
      { role: 'user', content: `task 1\n\n${lines}` }, unmarkedNote, { role: 'assistant', content: 'done 1' }, { role: 'user', content: 'task 2' }, marked('note'),
    ]));
    expect(appendedRead.readThrough).toBe('system[0]');

    const atCullPoint = new AnthropicPromptCacheModel();
    atCullPoint.send(body(turnStart));
    const atCullPointRead = atCullPoint.send(body([
      { role: 'user', content: 'task 1' }, unmarkedNote, { role: 'system', content: lines }, { role: 'assistant', content: 'done 1' }, { role: 'user', content: 'task 2' }, marked('note'),
    ]));
    expect(atCullPointRead).toMatchObject({ readThrough: 'messages[1][0]', entryWrittenByRequest: 0 });
  });

  it('a marker is not part of the prefix, and a breakpoint looks back 20 positions, a tool_result run counting as one', () => {
    const model = new AnthropicPromptCacheModel();
    model.send(body(turnStart));
    const filler = (count: number): Message[] => Array.from({ length: count }, (_, index) => ({ role: 'user', content: `filler ${index}` }));
    // 18 positions after the entry, then the breakpoint: 20 counting both ends.
    expect(model.send(body([...turnStart.slice(0, 1), unmarkedNote, ...filler(18), marked('end')])).readThrough).toBe('messages[1][0]');
    const far = new AnthropicPromptCacheModel();
    far.send(body(turnStart));
    expect(far.send(body([...turnStart.slice(0, 1), unmarkedNote, ...filler(19), marked('end')])).readThrough).toBe('system[0]');
    const results = new AnthropicPromptCacheModel();
    results.send(body(turnStart));
    const manyResults: Message = { role: 'user', content: Array.from({ length: 30 }, (_, index) => ({ type: 'tool_result', tool_use_id: `t${index}`, content: 'x' })) };
    expect(results.send(body([...turnStart.slice(0, 1), unmarkedNote, manyResults, marked('end')])).readThrough).toBe('messages[1][0]');
  });
});

describe('the head\'s cache breakpoint', () => {
  const encoder = new TextEncoder();
  const timeline = '<claude-mem-context>\nobs\n</claude-mem-context>';
  const header = '<claude-mem-rules>\nrules\n</claude-mem-rules>';
  const mark = (body: unknown, texts: string[] = [timeline, header]) => decoder.decode(withHeadCacheBreakpoint(encoder.encode(JSON.stringify(body)), new Set(texts)));
  const lastSystemBlockOf = (sent: string) => (JSON.parse(sent) as { system: unknown[] }).system.at(-1);
  const bodyWith = (systemMarkers: Array<Record<string, string> | null>, lastMessageMarker: Record<string, string> | null, extra: Record<string, unknown> = {}) => ({
    system: [
      ...systemMarkers.map((marker, index) => ({ type: 'text', text: `agent ${index}`, ...(marker ? { cache_control: marker } : {}) })),
      { type: 'text', text: header },
      { type: 'text', text: timeline },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', ...(lastMessageMarker ? { cache_control: lastMessageMarker } : {}) }] }],
    ...extra,
  });

  it('goes on the timeline block, 1-hour when a later breakpoint is, else the 5-minute default', () => {
    expect(lastSystemBlockOf(mark(bodyWith([ONE_HOUR], ONE_HOUR)))).toEqual({ type: 'text', text: timeline, cache_control: ONE_HOUR });
    expect(lastSystemBlockOf(mark(bodyWith([ONE_HOUR], { type: 'ephemeral' })))).toEqual({ type: 'text', text: timeline, cache_control: { type: 'ephemeral' } });
    expect(lastSystemBlockOf(mark(bodyWith([], null)))).toEqual({ type: 'text', text: timeline, cache_control: { type: 'ephemeral' } });
    // Top-level automatic caching marks the last block: a 1-hour one makes the head 1-hour too.
    expect(lastSystemBlockOf(mark(bodyWith([], null, { cache_control: ONE_HOUR })))).toEqual({ type: 'text', text: timeline, cache_control: ONE_HOUR });
  });

  it('goes on the header when there is no timeline, and never on a block the gateway did not add', () => {
    const headerOnly = bodyWith([], ONE_HOUR);
    headerOnly.system.pop();
    expect(lastSystemBlockOf(mark(headerOnly, [header]))).toEqual({ type: 'text', text: header, cache_control: ONE_HOUR });
    const body = JSON.stringify(bodyWith([], ONE_HOUR));
    expect(mark(JSON.parse(body), [])).toBe(body);
    expect(mark(JSON.parse(body), ['<claude-mem-context>\nsomething else\n</claude-mem-context>'])).toBe(body);
  });

  it('is left out at 4 breakpoints, after a 5-minute breakpoint that a 1-hour one follows, with an unknown TTL, and on a string system prompt', () => {
    for (const body of [
      bodyWith([ONE_HOUR, ONE_HOUR, ONE_HOUR], ONE_HOUR),
      bodyWith([{ type: 'ephemeral' }], ONE_HOUR),
      bodyWith([{ type: 'ephemeral', ttl: '2h' }], null),
      { system: 'one string', messages: [{ role: 'user', content: 'hi' }] },
    ]) {
      expect(mark(body)).toBe(JSON.stringify(body));
    }
  });

  it('gives the same request the same bytes, and a marked request is left as it is', () => {
    const body = bodyWith([ONE_HOUR], ONE_HOUR);
    const once = mark(body);
    expect(mark(body)).toBe(once);
    expect(mark(JSON.parse(once))).toBe(once);
  });
});
