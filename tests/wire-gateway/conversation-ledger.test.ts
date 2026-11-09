import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { parseWireRequest } from '../../src/services/wire-gateway/ir/request-parsers.js';
import type { WireIdentity } from '../../src/services/wire-gateway/identity/resolve-identity.js';
import { userTurnPositionOfRequest } from '../../src/services/wire-gateway/identity/turn-start.js';
import {
  WireConversationLedger,
  conversationKeyOf,
  ledgerEntryIdOf,
} from '../../src/services/wire-gateway/ledger/conversation-ledger.js';

// Phase 10 task 5: born only from a first request with one user turn and no
// assistant turn; first write wins per entry id; a restart reads the same
// entries; a corrupt line makes the conversation unknown.

const ledgerDirectory = join(WIRE_GATEWAY_DIR, 'conversation-ledger-test');
const encoder = new TextEncoder();

function requestOf(messages: unknown[]) {
  return parseWireRequest('anthropic', encoder.encode(JSON.stringify({ model: 'm', messages })));
}

const firstRequest = requestOf([{ role: 'user', content: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }, { type: 'text', text: 'build it' }] }]);
const laterRequest = requestOf([
  { role: 'user', content: 'build it' },
  { role: 'assistant', content: 'ok' },
  { role: 'user', content: 'and test it' },
]);

function identityFor(sessionId: string, request = firstRequest, overrides: Partial<WireIdentity> = {}): WireIdentity {
  return {
    agentId: 'claude-code',
    sessionId,
    sessionSource: 'header',
    kind: 'turn',
    userWords: '',
    userTurnOrdinal: userTurnPositionOfRequest(request).userTurnOrdinal,
    turnStart: true,
    ...overrides,
  };
}

beforeEach(() => rmSync(ledgerDirectory, { recursive: true, force: true }));
afterEach(() => rmSync(ledgerDirectory, { recursive: true, force: true }));

describe('conversation ledger', () => {
  it('marks a conversation born when its first request starts it, and writes that first', () => {
    const ledger = new WireConversationLedger({ directory: ledgerDirectory });
    const view = ledger.open(identityFor('born-1'), firstRequest)!;
    expect(view.status).toBe('born');
    expect(view.entries()[0].type).toBe('born');
    const file = join(ledgerDirectory, `${view.conversationKey}.jsonl`);
    expect(JSON.parse(readFileSync(file, 'utf8').trim())).toMatchObject({ type: 'born' });
    // Later requests of the same conversation stay born.
    expect(ledger.open(identityFor('born-1', laterRequest), laterRequest)!.status).toBe('born');
  });

  it('never marks born a conversation first seen mid-way, and writes nothing for it', () => {
    const ledger = new WireConversationLedger({ directory: ledgerDirectory });
    const view = ledger.open(identityFor('midway', laterRequest), laterRequest)!;
    expect(view.status).toBe('not_born');
    expect(() => view.record({ type: 'injection', text: 'x' })).toThrow(/not_born/);
    expect(existsSync(join(ledgerDirectory, `${view.conversationKey}.jsonl`))).toBe(false);
    // Even a fresh process meeting a later request does not call it born.
    expect(new WireConversationLedger({ directory: ledgerDirectory }).open(identityFor('midway', laterRequest), laterRequest)!.status).toBe('not_born');
  });

  it('keeps the first write of each entry id, also across a restart', () => {
    const ledger = new WireConversationLedger({ directory: ledgerDirectory });
    const view = ledger.open(identityFor('fww'), firstRequest)!;
    expect(view.record({ type: 'injection', text: 'first' })).toEqual({ type: 'injection', text: 'first' });
    expect(view.record({ type: 'injection', text: 'second' })).toEqual({ type: 'injection', text: 'first' });
    view.record({ type: 'swap', callId: 'c1', replacementText: 'r1', firstRequestAt: '2026-10-15T00:00:00.000Z', observationId: 1 });
    view.record({ type: 'swap', callId: 'c1', replacementText: 'other', firstRequestAt: '2026-10-16T00:00:00.000Z', observationId: 1 });
    view.record({ type: 'swap', callId: 'c2', replacementText: 'r2', firstRequestAt: '2026-10-15T00:00:00.000Z', observationId: 1, coveredByCallId: 'c1' });
    view.record({ type: 'thinkingDrop', boundaryMessageIndex: 3, untilMessageIndex: 6 });
    view.record({ type: 'thinkingDrop', boundaryMessageIndex: 3, untilMessageIndex: 9 });
    view.record({ type: 'suspended', stage: 'endless-mode', at: '2026-10-17T00:00:00.000Z' });
    view.record({ type: 'tool', name: 'memory_search', definitionJson: '{"name":"memory_search"}' });

    const restarted = new WireConversationLedger({ directory: ledgerDirectory }).open(identityFor('fww', laterRequest), laterRequest)!;
    expect(restarted.status).toBe('born');
    expect(restarted.get('injection')).toEqual({ type: 'injection', text: 'first' });
    expect(restarted.get('swap:c1')).toMatchObject({ replacementText: 'r1' });
    expect(restarted.entries().map(ledgerEntryIdOf)).toEqual(['born', 'injection', 'swap:c1', 'swap:c2', 'thinkingDrop:3:6', 'thinkingDrop:3:9', 'suspended:endless-mode', 'tool']);
    expect(readFileSync(join(ledgerDirectory, `${restarted.conversationKey}.jsonl`), 'utf8').trim().split('\n')).toHaveLength(8);
  });

  it('round-trips header, thinking cut and cull entries, first write wins by their ids', () => {
    const ledger = new WireConversationLedger({ directory: ledgerDirectory });
    const view = ledger.open(identityFor('v2'), firstRequest)!;
    const header = { type: 'header', text: '## Everywhere\n- rule', hash: 'h1', sequence: 0, turnOrdinal: 1 } as const;
    const noHeader = { type: 'header', text: null, hash: 'h0', sequence: 1, turnOrdinal: 3 } as const;
    const cut = { type: 'thinkingCut', untilTurnOrdinal: 3 } as const;
    const cull = { type: 'cull', turnOrdinal: 2, throughCallId: 'toolu_7', lines: ['12 3:04p 🔵 Read the ledger'], observationIds: [12], culledTokensEst: 900 } as const;
    const longerCull = {
      ...cull, throughCallId: 'toolu_9', lines: ['12 3:04p 🔵 Read the ledger', '13 3:05p 🟣 Added cull'], observationIds: [12, 13],
      linesPlacement: 'own-message-at-cull-point',
    } as const;
    expect(view.record(header)).toEqual(header);
    // One header per sequence number: a second one with the same number is ignored.
    expect(view.record({ ...header, text: 'other', hash: 'h2' })).toEqual(header);
    view.record(cut);
    expect(view.record({ type: 'thinkingCut', untilTurnOrdinal: 3 })).toEqual(cut);
    view.record(noHeader);
    expect(view.record(cull)).toEqual(cull);
    expect(view.record({ ...cull, lines: [], observationIds: [], culledTokensEst: 0 })).toEqual(cull);
    view.record(longerCull);

    const restarted = new WireConversationLedger({ directory: ledgerDirectory }).open(identityFor('v2', laterRequest), laterRequest)!;
    expect(restarted.status).toBe('born');
    expect(restarted.get('header:0')).toEqual(header);
    expect(restarted.get('header:1')).toEqual(noHeader);
    expect(restarted.get('thinkingCut:3')).toEqual(cut);
    // A cull line with no linesPlacement (written before there was one) reads back without one: put back as it was sent.
    expect(restarted.get('cull:2:toolu_7')).toEqual(cull);
    expect(restarted.get('cull:2:toolu_9')).toEqual(longerCull);
    expect(restarted.entries().map(ledgerEntryIdOf)).toEqual(['born', 'header:0', 'thinkingCut:3', 'header:1', 'cull:2:toolu_7', 'cull:2:toolu_9']);
  });

  it('records a header change back to an earlier text as a new entry (A -> B -> A)', () => {
    const view = new WireConversationLedger({ directory: ledgerDirectory }).open(identityFor('header-revert'), firstRequest)!;
    view.record({ type: 'header', text: 'A', hash: 'hA', sequence: 0, turnOrdinal: 1 });
    view.record({ type: 'header', text: 'B', hash: 'hB', sequence: 1, turnOrdinal: 3 });
    view.record({ type: 'header', text: 'A', hash: 'hA', sequence: 2, turnOrdinal: 5 });
    view.record({ type: 'header', text: 'C', hash: 'hC', sequence: 2, turnOrdinal: 5 });
    const restarted = new WireConversationLedger({ directory: ledgerDirectory }).open(identityFor('header-revert', laterRequest), laterRequest)!;
    const headers = restarted.entries().filter(entry => entry.type === 'header');
    expect(headers.map(ledgerEntryIdOf)).toEqual(['header:0', 'header:1', 'header:2']);
    expect(headers.map(entry => entry.type === 'header' && entry.text)).toEqual(['A', 'B', 'A']);
  });

  it('still reads a ledger holding old swap lines as born', () => {
    const key = conversationKeyOf(identityFor('old-swaps'));
    mkdirSync(ledgerDirectory, { recursive: true });
    writeFileSync(join(ledgerDirectory, `${key}.jsonl`), [
      JSON.stringify({ type: 'born', at: '2026-10-15T00:00:00.000Z' }),
      JSON.stringify({ type: 'swap', callId: 'c1', replacementText: 'r1', firstRequestAt: '2026-10-15T00:00:00.000Z', observationId: 1 }),
      JSON.stringify({ type: 'swap', callId: 'c2', replacementText: 'r2', firstRequestAt: '2026-10-15T00:00:00.000Z', observationId: 1, coveredByCallId: 'c1' }),
      JSON.stringify({ type: 'thinkingDrop', boundaryMessageIndex: 3, untilMessageIndex: 6 }),
    ].join('\n') + '\n');
    const view = new WireConversationLedger({ directory: ledgerDirectory }).open(identityFor('old-swaps', laterRequest), laterRequest)!;
    expect(view.status).toBe('born');
    expect(view.entries().map(ledgerEntryIdOf)).toEqual(['born', 'swap:c1', 'swap:c2', 'thinkingDrop:3:6']);
  });

  it('makes a conversation unknown when a header, thinking cut or cull line is malformed', () => {
    mkdirSync(ledgerDirectory, { recursive: true });
    const malformed = [
      { type: 'header', text: 'x', hash: 'h' },
      { type: 'header', text: 3, hash: 'h', sequence: 0, turnOrdinal: 1 },
      { type: 'header', text: 'x', hash: 'h', sequence: -1, turnOrdinal: 1 },
      { type: 'header', text: 'x', hash: 'h', firstTurnMessageIndex: 0 },
      { type: 'thinkingCut', untilTurnOrdinal: 1.5 },
      { type: 'thinkingCut' },
      { type: 'cull', turnOrdinal: 2, throughCallId: 'c', lines: ['ok', 4], observationIds: [1], culledTokensEst: 1 },
      { type: 'cull', turnOrdinal: -1, throughCallId: 'c', lines: [], observationIds: [], culledTokensEst: 1 },
      { type: 'cull', turnOrdinal: 2, throughCallId: '', lines: ['x'], observationIds: [1], culledTokensEst: 1 },
      { type: 'cull', turnOrdinal: 2, throughCallId: 7, lines: ['x'], observationIds: [1], culledTokensEst: 1 },
      { type: 'cull', turnOrdinal: 2, throughCallId: 'c', lines: ['x'], observationIds: [1.5], culledTokensEst: 1 },
      { type: 'cull', turnOrdinal: 2, throughCallId: 'c', lines: ['x'], observationIds: [-1], culledTokensEst: 1 },
      { type: 'cull', turnOrdinal: 2, throughCallId: 'c', lines: ['x', 'y'], observationIds: [1], culledTokensEst: 1 },
      { type: 'cull', turnOrdinal: 2, throughCallId: 'c', lines: ['x'], observationIds: [1, 2], culledTokensEst: 1 },
      { type: 'cull', turnMessageIndex: 2, throughMessageIndex: 7, lines: ['x'], observationIds: [1], culledTokensEst: 1 },
      { type: 'cull', turnOrdinal: 2, throughCallId: 'c', lines: ['x'], observationIds: [1], culledTokensEst: 1, linesPlacement: 'in-the-reply' },
      { type: 'cull', turnOrdinal: 2, throughCallId: 'c', lines: ['x'], observationIds: [1], culledTokensEst: 1, linesPlacement: null },
    ];
    malformed.forEach((entry, index) => {
      const sessionId = `malformed-${index}`;
      writeFileSync(join(ledgerDirectory, `${conversationKeyOf(identityFor(sessionId))}.jsonl`),
        `${JSON.stringify({ type: 'born', at: 'x' })}\n${JSON.stringify(entry)}\n`);
      expect(new WireConversationLedger({ directory: ledgerDirectory }).open(identityFor(sessionId), firstRequest)!.status).toBe('unknown');
    });
  });

  it('opens an existing ledger without creating one, and still judges a later first sight', () => {
    const ledger = new WireConversationLedger({ directory: ledgerDirectory });
    expect(ledger.openExisting(identityFor('existing-none'))).toBeNull();
    expect(existsSync(join(ledgerDirectory, `${conversationKeyOf(identityFor('existing-none'))}.jsonl`))).toBe(false);
    // A conversation openExisting found nothing for is still born by its first request.
    expect(ledger.open(identityFor('existing-none'), firstRequest)!.status).toBe('born');
    expect(ledger.openExisting(identityFor('existing-none'))!.status).toBe('born');
    ledger.open(identityFor('existing-on-disk'), firstRequest)!.record({ type: 'injection', text: 'kept' });
    const restarted = new WireConversationLedger({ directory: ledgerDirectory });
    expect(restarted.openExisting(identityFor('existing-on-disk'))!.get('injection')).toEqual({ type: 'injection', text: 'kept' });
  });

  it('keeps the first of two lines with one id even when the file holds both', () => {
    const key = conversationKeyOf(identityFor('dup'));
    mkdirSync(ledgerDirectory, { recursive: true });
    writeFileSync(join(ledgerDirectory, `${key}.jsonl`), [
      JSON.stringify({ type: 'born', at: '2026-10-15T00:00:00.000Z' }),
      JSON.stringify({ type: 'injection', text: 'kept' }),
      JSON.stringify({ type: 'injection', text: 'ignored' }),
    ].join('\n') + '\n');
    const view = new WireConversationLedger({ directory: ledgerDirectory }).open(identityFor('dup', laterRequest), laterRequest)!;
    expect(view.get('injection')).toEqual({ type: 'injection', text: 'kept' });
  });

  it('makes a conversation unknown when a line is corrupt, and never writes to it', () => {
    const ledger = new WireConversationLedger({ directory: ledgerDirectory });
    const key = ledger.open(identityFor('corrupt'), firstRequest)!.conversationKey;
    const file = join(ledgerDirectory, `${key}.jsonl`);
    appendFileSync(file, '{"type":"swap","callId":\n');
    const before = readFileSync(file, 'utf8');
    const view = new WireConversationLedger({ directory: ledgerDirectory }).open(identityFor('corrupt', laterRequest), laterRequest)!;
    expect(view.status).toBe('unknown');
    expect(view.entries()).toEqual([]);
    expect(() => view.record({ type: 'injection', text: 'x' })).toThrow(/unknown/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('makes a conversation unknown when its file does not begin with its birth, or holds an unknown entry', () => {
    mkdirSync(ledgerDirectory, { recursive: true });
    const noBirth = conversationKeyOf(identityFor('no-birth'));
    writeFileSync(join(ledgerDirectory, `${noBirth}.jsonl`), `${JSON.stringify({ type: 'injection', text: 'x' })}\n`);
    expect(new WireConversationLedger({ directory: ledgerDirectory }).open(identityFor('no-birth'), firstRequest)!.status).toBe('unknown');
    const unknownType = conversationKeyOf(identityFor('odd-type'));
    writeFileSync(join(ledgerDirectory, `${unknownType}.jsonl`), `${JSON.stringify({ type: 'born', at: 'x' })}\n${JSON.stringify({ type: 'mystery' })}\n`);
    expect(new WireConversationLedger({ directory: ledgerDirectory }).open(identityFor('odd-type'), firstRequest)!.status).toBe('unknown');
  });

  it('keeps no ledger for helpers and compaction, and one per subagent', () => {
    const ledger = new WireConversationLedger({ directory: ledgerDirectory });
    expect(ledger.open(identityFor('h', firstRequest, { kind: 'helper:title' }), firstRequest)).toBeNull();
    expect(ledger.open(identityFor('h', firstRequest, { kind: 'compaction' }), firstRequest)).toBeNull();
    const parent = ledger.open(identityFor('h'), firstRequest)!;
    const subagent = ledger.open(identityFor('h', firstRequest, { kind: 'subagent', subagent: 'agent-1' }), firstRequest)!;
    expect(subagent.conversationKey).not.toBe(parent.conversationKey);
    expect(subagent.status).toBe('born');
  });

  it('deletes ledgers untouched for 30 days', () => {
    const ledger = new WireConversationLedger({ directory: ledgerDirectory });
    const old = ledger.open(identityFor('old'), firstRequest)!;
    const fresh = ledger.open(identityFor('fresh'), firstRequest)!;
    const oldFile = join(ledgerDirectory, `${old.conversationKey}.jsonl`);
    const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, longAgo, longAgo);
    expect(ledger.pruneExpired()).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(join(ledgerDirectory, `${fresh.conversationKey}.jsonl`))).toBe(true);
    // A pruned conversation is history the gateway no longer knows: not born.
    expect(ledger.open(identityFor('old', laterRequest), laterRequest)!.status).toBe('not_born');
  });
});
