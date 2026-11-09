// SPDX-License-Identifier: Apache-2.0
//
// Codex's turn metadata (plan Phase 4 tasks 2-4). Ported from magpie
// `requestSessionMetadata` (internal/gateway/session_parent.go:24-73), `callKind`
// and `threadSource` (internal/gateway/codex_backend.go:1102-1149) and the
// kind alias table (internal/usage/purpose.go:20-32); MIT, Copyright (c) 2026
// yetone.
//
// Codex projects its turn metadata into headers, but its canonical transport
// is `client_metadata` in the Responses body. Where this differs from magpie,
// on purpose: it also reads `thread_id`, `session_id` and `agent_name` (magpie
// reads no session id from a body), so a session and a subagent can be named.
//
// The body read here is the gateway's decoded copy, never the forwarded
// bytes, so JSON.parse is safe.

export interface CodexTurnMetadata {
  turnId?: string;
  threadSource?: string;
  parentThreadId?: string;
  forkedFromThreadId?: string;
  installationId?: string;
  threadId?: string;
  sessionId?: string;
  /** "/root" for the user's own thread; "/root/<name>" for a spawned agent. */
  agentName?: string;
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function stringField(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function turnMetadataFrom(fields: Record<string, unknown>): CodexTurnMetadata {
  return {
    turnId: stringField(fields, 'turn_id'),
    threadSource: stringField(fields, 'thread_source'),
    parentThreadId: stringField(fields, 'parent_thread_id'),
    forkedFromThreadId: stringField(fields, 'forked_from_thread_id'),
    installationId: stringField(fields, 'installation_id'),
    threadId: stringField(fields, 'thread_id'),
    sessionId: stringField(fields, 'session_id'),
    agentName: stringField(fields, 'agent_name'),
  };
}

/** `client_metadata["x-codex-turn-metadata"]`, as a JSON string or an object. */
function embeddedTurnMetadataFields(clientMetadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const embedded = clientMetadata['x-codex-turn-metadata'];
  if (typeof embedded === 'string') return parseJsonObject(embedded);
  if (embedded && typeof embedded === 'object' && !Array.isArray(embedded)) return embedded as Record<string, unknown>;
  return undefined;
}

/**
 * The turn metadata a Codex request carries, looked up as magpie does:
 * 1. the body's `client_metadata["x-codex-turn-metadata"]`;
 * 2. the flat keys of `client_metadata`, used for lineage only when a source, parent or fork is set;
 * 3. the `x-codex-turn-metadata` header, keeping the body's turn id.
 * The flat thread and session ids are kept whichever source wins.
 */
export function codexTurnMetadataOf(headers: Headers, clientMetadataJson: string | undefined): CodexTurnMetadata {
  const clientMetadata = parseJsonObject(clientMetadataJson);
  const flatThreadId = clientMetadata ? stringField(clientMetadata, 'thread_id') : undefined;
  const flatSessionId = clientMetadata ? stringField(clientMetadata, 'session_id') : undefined;
  const withFlatIds = (metadata: CodexTurnMetadata): CodexTurnMetadata => ({
    ...metadata,
    threadId: flatThreadId ?? metadata.threadId,
    sessionId: flatSessionId ?? metadata.sessionId,
  });

  let projectedTurnId: string | undefined;
  if (clientMetadata) {
    const embedded = embeddedTurnMetadataFields(clientMetadata);
    if (embedded) return withFlatIds(turnMetadataFrom(embedded));
    if ('x-codex-turn-metadata' in clientMetadata) {
      // Present but unreadable: fall through to the header, as magpie does.
    } else {
      const flat = turnMetadataFrom(clientMetadata);
      flat.parentThreadId ??= stringField(clientMetadata, 'x-codex-parent-thread-id');
      projectedTurnId = flat.turnId;
      if (flat.threadSource || flat.parentThreadId || flat.forkedFromThreadId) return withFlatIds(flat);
    }
  }
  const fromHeader = parseJsonObject(headers.get('x-codex-turn-metadata') ?? undefined);
  if (!fromHeader) return withFlatIds({ turnId: projectedTurnId });
  const metadata = turnMetadataFrom(fromHeader);
  if (projectedTurnId) metadata.turnId = projectedTurnId;
  return withFlatIds(metadata);
}

const MAX_CODEX_CALL_KIND_LENGTH = 40;

/**
 * The side kind a Codex call is (magpie `callKind` + `requestCallKind`):
 * `x-openai-subagent`, then `x-openai-memgen-request` (memgen), then the
 * thread source when it is not the user's or a subagent's, then
 * `x-openai-codex-luna-reserve`. "" for the user's own thread.
 */
export function codexCallKindOf(headers: Headers, metadata: CodexTurnMetadata): string {
  let kind = (headers.get('x-openai-subagent') ?? '').trim();
  if (kind === '' && headers.get('x-openai-memgen-request')) kind = 'memgen';
  if (kind === '') {
    const source = (metadata.threadSource ?? '').trim();
    if (source !== 'user' && source !== 'subagent') kind = source;
  }
  if (kind === '' && headers.get('x-openai-codex-luna-reserve')) kind = 'luna_reserve';
  return kind.slice(0, MAX_CODEX_CALL_KIND_LENGTH);
}

export type CodexCallPurpose = 'helper' | 'subagent' | 'compaction';

/**
 * magpie's alias table (usage/purpose.go:20-32): each kind maps to the first
 * kind of its group, which names it. The Subagent group spawns agents; the
 * Compaction group compacts; every other group is a helper.
 */
const CODEX_CALL_KIND_GROUPS: ReadonlyArray<{ purpose: CodexCallPurpose; kinds: readonly string[] }> = [
  { purpose: 'helper', kinds: ['guardian', 'auto_review', 'guardian_review'] },
  { purpose: 'helper', kinds: ['review'] },
  { purpose: 'compaction', kinds: ['compact'] },
  { purpose: 'helper', kinds: ['memory_consolidation', 'memgen', 'memory'] },
  { purpose: 'helper', kinds: ['thread_title', 'thread_title_reconsideration', 'title_generation', 'title'] },
  { purpose: 'helper', kinds: ['thread_description'] },
  { purpose: 'helper', kinds: ['composer_predictions'] },
  { purpose: 'subagent', kinds: ['collab_spawn', 'thread_spawn', 'agent_job'] },
  { purpose: 'helper', kinds: ['luna_reserve'] },
  { purpose: 'helper', kinds: ['ambient_suggestions', 'ambient_suggestion_safety'] },
];

export interface CodexCallPurposeOfKind {
  purpose: CodexCallPurpose;
  /** The group's name: its first kind, or the kind itself when no group lists it. */
  canonicalKind: string;
}

/** What a non-empty Codex call kind is for. An unlisted kind is a helper: it is never the user's turn. */
export function codexCallPurposeOf(kind: string): CodexCallPurposeOfKind {
  for (const group of CODEX_CALL_KIND_GROUPS) {
    if (group.kinds.includes(kind)) return { purpose: group.purpose, canonicalKind: group.kinds[0] };
  }
  return { purpose: 'helper', canonicalKind: kind };
}

export function isCodexTitleKind(kind: string): boolean {
  return kind === 'thread_title' || kind === 'thread_title_reconsideration' || kind === 'title_generation';
}
