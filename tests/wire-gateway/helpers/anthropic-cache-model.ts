// A model of Anthropic's prompt cache, for tests that check which cache
// entries a sequence of requests can reuse. The rules, from the prompt
// caching docs (platform.claude.com/docs/en/build-with-claude/prompt-caching):
// - "Cache writes occur only at your breakpoint ... a hash of the prefix
//   ending at that block. The system does not write entries for any earlier
//   position."
// - "Cache hits require 100 percent identical prompt segments": the hash is
//   cumulative over tools → system → messages, so a change at or before a
//   block changes the hash there and at every later block.
// - "The system checks at most 20 positions for each breakpoint, counting
//   the breakpoint itself as the first ... a run of consecutive tool_use
//   blocks counts as one position, and so does a run of consecutive
//   tool_result blocks."
// - A marker is not part of the prefix: "blocks that were previously marked
//   with a cache_control block are later not marked with this, but they will
//   still be considered a cache hit". The model strips cache_control before
//   hashing.
// TTLs, minimum cacheable lengths and timing are left out: every entry lives
// for the whole test, so only prefix and lookback decide a read.

import { createHash } from 'crypto';

/** "at most 20 positions for each breakpoint, counting the breakpoint itself as the first" (prompt caching docs). */
export const ANTHROPIC_CACHE_LOOKBACK_POSITIONS = 20;

interface Position {
  /** Hash of the prefix through this position. */
  prefixHash: string;
  /** Where it is, for messages: `system[2]`, `messages[4][0]`. */
  label: string;
  marked: boolean;
}

/** What one request reads from the cache, and which earlier request wrote that entry. */
export interface CacheRead {
  /** The request's index in the sequence. */
  requestIndex: number;
  /** The label of the position the read reaches; null when nothing is read. */
  readThrough: string | null;
  /** The index of the request whose breakpoint wrote the entry read; null when nothing is read. */
  entryWrittenByRequest: number | null;
  /** The labels of the positions this request's breakpoints write. */
  writes: string[];
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (value === null || typeof value !== 'object') return value;
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (key !== 'cache_control') kept[key] = withoutCacheControl((value as Record<string, unknown>)[key]);
  }
  return kept;
}

type Block = Record<string, unknown>;

const blocksOf = (content: unknown): Block[] => typeof content === 'string' ? [{ type: 'text', text: content }] : content as Block[];

/** A request's positions in render order (tools → system → messages), each with the hash of the prefix through it. */
export function cachePositionsOf(body: Record<string, unknown>): Position[] {
  const positions: Position[] = [];
  const hash = createHash('sha256');
  let openRun: string | null = null;
  const add = (label: string, block: unknown, runKind: string | null) => {
    hash.update(JSON.stringify(withoutCacheControl(block)));
    const marked = typeof block === 'object' && block !== null && 'cache_control' in block;
    const prefixHash = hash.copy().digest('hex');
    if (runKind !== null && runKind === openRun) {
      const previous = positions[positions.length - 1];
      positions[positions.length - 1] = { prefixHash, label: previous.label, marked: previous.marked || marked };
      return;
    }
    positions.push({ prefixHash, label, marked });
    openRun = runKind;
  };
  ((body.tools as Block[] | undefined) ?? []).forEach((tool, index) => add(`tools[${index}]`, tool, null));
  blocksOf(body.system ?? []).forEach((block, index) => add(`system[${index}]`, block, null));
  (body.messages as Array<{ role: string; content: unknown }>).forEach((message, messageIndex) => {
    hash.update(`\u0000${message.role}\u0000`);
    openRun = null;
    blocksOf(message.content).forEach((block, blockIndex) => {
      const type = block.type as string;
      add(`messages[${messageIndex}][${blockIndex}]`, block, type === 'tool_use' || type === 'tool_result' ? type : null);
    });
  });
  return positions;
}

/** Requests sent one after another, each reading what it can and then writing at its breakpoints. */
export class AnthropicPromptCacheModel {
  private readonly entries = new Map<string, number>();
  private sent = 0;

  send(bodyJson: string): CacheRead {
    const positions = cachePositionsOf(JSON.parse(bodyJson) as Record<string, unknown>);
    const requestIndex = this.sent++;
    let best: { at: number; writer: number } | null = null;
    positions.forEach((position, at) => {
      if (!position.marked) return;
      for (let back = at; back > at - ANTHROPIC_CACHE_LOOKBACK_POSITIONS && back >= 0; back--) {
        const writer = this.entries.get(positions[back].prefixHash);
        if (writer === undefined) continue;
        if (!best || back > best.at) best = { at: back, writer };
        break;
      }
    });
    const writes: string[] = [];
    for (const position of positions) {
      if (!position.marked) continue;
      writes.push(position.label);
      if (!this.entries.has(position.prefixHash)) this.entries.set(position.prefixHash, requestIndex);
    }
    const read = best as { at: number; writer: number } | null;
    return { requestIndex, readThrough: read ? positions[read.at].label : null, entryWrittenByRequest: read ? read.writer : null, writes };
  }
}
