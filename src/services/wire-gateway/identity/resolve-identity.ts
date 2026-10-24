// SPDX-License-Identifier: Apache-2.0
//
// Who sent a request and where it belongs (plan Phase 4, design Part 5):
// agent, session, subagent and lineage, kind, folder, the user's words and
// whether the request starts a user turn. Pure: it reads the route, the
// request headers and the parsed decoded body, and never the forwarded bytes.

import type { WireRequest } from '../ir/types.js';
import { resolveAgentId } from './agent-of.js';
import {
  codexCallKindOf,
  codexCallPurposeOf,
  codexTurnMetadataOf,
  isCodexTitleKind,
  type CodexTurnMetadata,
} from './codex-turn-metadata.js';
import type { WireLaunch } from './launch-registry.js';
import {
  hasCodexCompactionTrigger,
  isAutoModeClassifierRequest,
  isCompactionPromptRequest,
  isSuggestionModeRequest,
  isTitleHelperRequest,
  kindFromClaudeCodeRequestClass,
  type WireRequestKind,
} from './request-kind.js';
import {
  CLAUDE_MEM_SESSION_HEADER,
  cleanSessionId,
  fingerprintSessionId,
  sessionIdFromAgentHeaders,
  sessionIdFromRequestBody,
} from './session-id.js';
import { userTurnPositionOfRequest } from './turn-start.js';
import { firstUserWordsOfConversation, latestUserWordsOfConversation } from './user-words.js';
import { gitRepositoryOnDisk, workPlaceOfRequest } from './work-dir.js';

/**
 * Where the session id came from, in precedence order:
 * named (`x-claude-mem-session`), header (an agent session header), body (an
 * id in the request body), launch (`/l/<launchId>`), fingerprint (derived
 * from the user's first words). A launch still gives the folder either way.
 */
export type WireSessionSource = 'named' | 'header' | 'body' | 'launch' | 'fingerprint';

export interface WireIdentity {
  agentId: string;
  sessionId: string;
  sessionSource: WireSessionSource;
  /** A subagent's id: Claude Code's `x-claude-code-agent-id`, Codex's agent name or spawn kind. The session stays the parent's for Claude Code. */
  subagent?: string;
  /** Claude Code's `x-claude-code-parent-agent-id`, sent only with an agent id. */
  parentSubagent?: string;
  /** Codex: the thread a subagent or side call was made from. */
  parentSessionId?: string;
  kind: WireRequestKind;
  /** Unknown is undefined, never "". */
  workDir?: string;
  /** What the agent says of git beside its folder, else what the disk says when the folder is here. */
  workDirIsGitRepository?: boolean;
  /** The words of the last user message that said anything; "" when none did. */
  userWords: string;
  /** How many user turns the conversation holds so far. */
  userTurnOrdinal: number;
  /** The request carries the user's new words (or image or file): it starts a user turn. */
  turnStart: boolean;
  /** The agent's own id for this prompt: `x-claude-code-prompt-id`, or Codex's `turn_id`. */
  nativePromptId?: string;
}

// A header value is a ByteString: Headers.set throws on a character past U+00FF.
const NOT_A_HEADER_VALUE_PATTERN = /[^\u0020-\u007e\u00a0-\u00ff]/;

/**
 * The session to echo in `x-claude-mem-session`, or undefined: only a session
 * the client named (sources 1–4, not a fingerprint), and only when it fits in
 * a header (a body id is any JSON string, and an unencodable echo must never
 * fail the relay).
 */
export function sessionIdToEcho(identity: Pick<WireIdentity, 'sessionId' | 'sessionSource'>): string | undefined {
  if (identity.sessionSource === 'fingerprint') return undefined;
  return NOT_A_HEADER_VALUE_PATTERN.test(identity.sessionId) ? undefined : identity.sessionId;
}

export interface ResolveIdentityContext {
  /** The route suffix the request is for (without its launch segment). */
  suffixPath: string;
  /** The launch the request came through, when it came through a known one. */
  launch?: WireLaunch;
}

const MAX_SUBAGENT_ID_BYTES = 128;

function headerFlagIsSet(value: string | null): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

interface SubagentLineage {
  subagent?: string;
  parentSubagent?: string;
  parentSessionId?: string;
}

/** Claude Code names a subagent (and its parent, only with an agent id) in headers (magpie `subagentOf`). */
function claudeCodeSubagentLineage(headers: Headers): SubagentLineage {
  const subagent = cleanSessionId(headers.get('x-claude-code-agent-id'));
  if (!subagent) return {};
  const parentSubagent = cleanSessionId(headers.get('x-claude-code-parent-agent-id'));
  return parentSubagent ? { subagent, parentSubagent } : { subagent };
}

/**
 * The thread a Codex side call or subagent was made from (magpie
 * `titleParentSession`, widened from title kinds to every side call): the
 * metadata's parent, a fork's origin for title kinds only (a user-made fork
 * is its own conversation), then `x-codex-parent-thread-id`. The request's
 * own session never counts.
 */
function codexParentSessionId(headers: Headers, metadata: CodexTurnMetadata, callKind: string, ownSessionId: string): string | undefined {
  const candidates = [metadata.parentThreadId, isCodexTitleKind(callKind) ? metadata.forkedFromThreadId : undefined, headers.get('x-codex-parent-thread-id')];
  for (const candidate of candidates) {
    const parentSessionId = cleanSessionId(candidate);
    if (parentSessionId && parentSessionId !== ownSessionId) return parentSessionId;
  }
  return undefined;
}

const CODEX_ROOT_AGENT_NAME = '/root';

interface KindAndLineage extends SubagentLineage {
  kind: WireRequestKind;
}

/**
 * The request's kind. Claude Code's request-class hint wins when present.
 * Otherwise: the path (count_tokens, Responses compact), compaction signs,
 * Codex call kinds, the helper detectors, then a subagent's headers or
 * metadata; anything else is the user's turn.
 */
function resolveKindAndLineage(
  headers: Headers,
  request: WireRequest | null,
  agentId: string,
  suffixPath: string,
  codexMetadata: CodexTurnMetadata,
  sessionId: string,
): KindAndLineage {
  const claudeLineage = claudeCodeSubagentLineage(headers);
  const hintedKind = kindFromClaudeCodeRequestClass(headers.get('x-claude-code-request-class'));
  if (hintedKind) return { kind: hintedKind, ...claudeLineage };

  if (suffixPath.endsWith('/count_tokens')) return { kind: 'helper:count_tokens', ...claudeLineage };
  if (suffixPath.endsWith('/responses/compact')) return { kind: 'compaction' };
  if (headerFlagIsSet(headers.get('x-claude-code-compaction'))) return { kind: 'compaction', ...claudeLineage };

  const codexCallKind = codexCallKindOf(headers, codexMetadata);
  const codexPurpose = codexCallKind ? codexCallPurposeOf(codexCallKind) : null;
  const codexParent = codexCallKind || codexMetadata.threadSource === 'subagent'
    ? codexParentSessionId(headers, codexMetadata, codexCallKind, sessionId)
    : undefined;
  const codexLineage: SubagentLineage = codexParent ? { parentSessionId: codexParent } : {};

  if (request && (hasCodexCompactionTrigger(request) || isCompactionPromptRequest(request))) return { kind: 'compaction', ...claudeLineage, ...codexLineage };
  if (codexPurpose?.purpose === 'compaction') return { kind: 'compaction', ...codexLineage };
  if (codexPurpose?.purpose === 'helper') return { kind: `helper:${codexPurpose.canonicalKind}`, ...codexLineage };

  if (request) {
    if (isAutoModeClassifierRequest(request)) return { kind: 'helper:auto_mode_classifier', ...claudeLineage };
    if (isTitleHelperRequest(request, agentId)) return { kind: 'helper:title', ...claudeLineage };
    if (isSuggestionModeRequest(request)) return { kind: 'helper:suggestion', ...claudeLineage };
  }

  if (claudeLineage.subagent) return { kind: 'subagent', ...claudeLineage };
  const codexAgentName = cleanSessionId(codexMetadata.agentName);
  if (codexPurpose?.purpose === 'subagent' || codexMetadata.threadSource === 'subagent') {
    const subagent = codexAgentName && codexAgentName !== CODEX_ROOT_AGENT_NAME ? codexAgentName : codexCallKind || 'subagent';
    return { kind: 'subagent', subagent: subagent.slice(0, MAX_SUBAGENT_ID_BYTES), ...codexLineage };
  }
  return { kind: 'turn' };
}

/**
 * Resolve a request's identity. `request` is the parsed decoded body, or
 * null when there is none to read (a relay-only path, a body that did not
 * decode or parse); then only headers, the launch and the route speak.
 */
export function resolveIdentity(
  route: { agentId: string },
  headers: Headers,
  request: WireRequest | null,
  context: ResolveIdentityContext,
): WireIdentity {
  const agentId = resolveAgentId(route.agentId, headers.get('user-agent'));
  const codexMetadata = request?.protocol === 'openai-responses' || headers.has('x-codex-turn-metadata')
    ? codexTurnMetadataOf(headers, request?.clientMetadata)
    : {};

  let sessionId: string | undefined;
  let sessionSource: WireSessionSource;
  const namedSessionId = cleanSessionId(headers.get(CLAUDE_MEM_SESSION_HEADER));
  const headerSessionId = sessionIdFromAgentHeaders(headers);
  const bodySessionId = request ? sessionIdFromRequestBody(request, codexMetadata) : undefined;
  if (namedSessionId) {
    [sessionId, sessionSource] = [namedSessionId, 'named'];
  } else if (headerSessionId) {
    [sessionId, sessionSource] = [headerSessionId, 'header'];
  } else if (bodySessionId) {
    [sessionId, sessionSource] = [bodySessionId, 'body'];
  } else if (context.launch) {
    // After the agent's own id: `claude --resume` or `codex resume` under a
    // new `wire run` is one conversation with a new launch (seen live, where
    // launch first split one resumed session into four).
    [sessionId, sessionSource] = [context.launch.launchId, 'launch'];
  } else {
    [sessionId, sessionSource] = [fingerprintSessionId(agentId, request ? firstUserWordsOfConversation(request) : ''), 'fingerprint'];
  }

  const { kind, ...lineage } = resolveKindAndLineage(headers, request, agentId, context.suffixPath, codexMetadata, sessionId);

  const identity: WireIdentity = {
    agentId,
    sessionId,
    sessionSource,
    ...lineage,
    kind,
    userWords: request ? latestUserWordsOfConversation(request) : '',
    userTurnOrdinal: 0,
    turnStart: false,
  };

  if (request) {
    const position = userTurnPositionOfRequest(request);
    identity.userTurnOrdinal = position.userTurnOrdinal;
    identity.turnStart = position.userTurnOrdinal > 0 && !position.withinTurn;
  }

  if (context.launch) {
    identity.workDir = context.launch.cwd;
  } else if (request) {
    const workPlace = workPlaceOfRequest(request);
    if (workPlace.workDir !== undefined) identity.workDir = workPlace.workDir;
    if (workPlace.gitRepositorySaid !== undefined) identity.workDirIsGitRepository = workPlace.gitRepositorySaid;
  }
  if (identity.workDir !== undefined && identity.workDirIsGitRepository === undefined) {
    const onDisk = gitRepositoryOnDisk(identity.workDir);
    if (onDisk !== undefined) identity.workDirIsGitRepository = onDisk;
  }

  const nativePromptId = cleanSessionId(headers.get('x-claude-code-prompt-id')) ?? cleanSessionId(codexMetadata.turnId);
  if (nativePromptId) identity.nativePromptId = nativePromptId;
  return identity;
}
