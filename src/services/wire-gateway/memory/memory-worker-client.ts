// SPDX-License-Identifier: Apache-2.0
//
// What the memory stages ask the worker (plan Phase 12): the context the
// SessionStart hook injects (GET /api/context/inject, text/plain), the
// owner's rules for the durable header (GET /api/wire/header, Endless Mode
// v2 Phase 3: {text, hash}), and a
// memory search for the hidden memory_search tool (POST /api/dumb-search,
// the route §0.1 knew as /api/mem-search: the same progressive search,
// answering {content:[{type:'text',text}], isError?}). Both are loopback
// calls over direct-http.ts, so a proxy set in the environment never stands
// between the gateway and its worker.

import { buildWorkerUrl } from '../../../shared/worker-utils.js';
import { describeDirectHttpFailure, requestDirectly, requestDirectlyWithOutcome, requestJsonDirectly } from '../direct-http.js';

export interface MemoryContextQuery {
  /** The agent's folder; the worker resolves its project keys from it, as it does for hosts that send only a cwd. */
  workDir: string;
  /** The agent id; the worker normalizes it. */
  platformSource: string;
  timeoutMs: number;
}

/** The context text, '' when the worker has none for the folder. Throws when the worker cannot be asked or refuses. */
export type MemoryContextFetcher = (query: MemoryContextQuery) => Promise<string>;

export interface MemorySearchQuery {
  query: string;
  limit?: number;
  /** The agent's folder, when known: the worker scopes the search to that checkout's projects. */
  workDir?: string;
  timeoutMs: number;
  /** Aborts when the agent's request goes away. */
  signal?: AbortSignal;
}

export interface MemorySearchAnswer {
  text: string;
  isError: boolean;
}

/** The search's answer as tool result text. Throws when the worker cannot be asked. */
export type MemorySearcher = (query: MemorySearchQuery) => Promise<MemorySearchAnswer>;

/** The worker's /api/context/inject for a folder. `workerUrlOf` is a test seam. */
export async function fetchMemoryContextFromWorker(
  query: MemoryContextQuery,
  workerUrlOf: (apiPath: string) => string = buildWorkerUrl,
): Promise<string> {
  const search = new URLSearchParams({ cwd: query.workDir, platformSource: query.platformSource });
  const answer = await requestDirectly({ url: workerUrlOf(`/api/context/inject?${search}`), timeoutMs: query.timeoutMs });
  if (!answer) throw new Error('the worker did not answer /api/context/inject');
  if (answer.statusCode !== 200) throw new Error(`the worker answered /api/context/inject with ${answer.statusCode}`);
  return answer.bodyText.trim();
}

export interface DurableHeaderQuery {
  /** The agent's folder; the worker narrows the rules to its projects. */
  workDir: string;
  timeoutMs: number;
}

/** The worker's answer: the rules (null when none apply) and the sha256 hex of their text. */
export interface DurableHeaderAnswer {
  text: string | null;
  hash: string;
}

/** Throws when the worker cannot be asked or refuses. */
export type DurableHeaderFetcher = (query: DurableHeaderQuery) => Promise<DurableHeaderAnswer>;

/** The worker's /api/wire/header for a folder. `workerUrlOf` is a test seam. */
export async function fetchDurableHeaderFromWorker(
  query: DurableHeaderQuery,
  workerUrlOf: (apiPath: string) => string = buildWorkerUrl,
): Promise<DurableHeaderAnswer> {
  const search = new URLSearchParams({ cwd: query.workDir });
  const answer = await requestJsonDirectly<{ text?: unknown; hash?: unknown }>({ url: workerUrlOf(`/api/wire/header?${search}`), timeoutMs: query.timeoutMs });
  if (!answer) throw new Error('the worker did not answer /api/wire/header');
  if (answer.statusCode !== 200) throw new Error(`the worker answered /api/wire/header with ${answer.statusCode}`);
  const text = answer.body?.text;
  const hash = answer.body?.hash;
  if ((typeof text !== 'string' && text !== null) || typeof hash !== 'string' || hash === '') {
    throw new Error('the worker answered /api/wire/header with something that is not a header');
  }
  return { text: text === null || text.trim() === '' ? null : text.trim(), hash };
}

interface DumbSearchAnswer {
  content?: Array<{ type?: unknown; text?: unknown }>;
  isError?: unknown;
}

/** The worker's /api/dumb-search for one query. `workerUrlOf` is a test seam. */
export async function searchMemoryInWorker(
  query: MemorySearchQuery,
  workerUrlOf: (apiPath: string) => string = buildWorkerUrl,
): Promise<MemorySearchAnswer> {
  const outcome = await requestDirectlyWithOutcome({
    url: workerUrlOf('/api/dumb-search'),
    method: 'POST',
    jsonBody: {
      query: query.query,
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      // The worker resolves the folder's project keys, as for /api/context/inject:
      // the gateway never runs git on its own event loop.
      ...(query.workDir ? { cwd: query.workDir } : {}),
    },
    timeoutMs: query.timeoutMs,
    signal: query.signal,
  });
  // Aborted (the agent's request went away), timed out, or unreachable: each said as it is.
  if ('failure' in outcome) throw new Error(describeDirectHttpFailure(outcome.failure, 'the worker'));
  const answer = outcome.response;
  if (answer.statusCode !== 200) throw new Error(`the worker answered ${answer.statusCode}`);
  let parsed: DumbSearchAnswer;
  try {
    parsed = JSON.parse(answer.bodyText) as DumbSearchAnswer;
  } catch {
    throw new Error('the worker answered something that is not JSON');
  }
  const text = (parsed.content ?? [])
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text as string)
    .join('\n');
  return { text, isError: parsed.isError === true };
}
