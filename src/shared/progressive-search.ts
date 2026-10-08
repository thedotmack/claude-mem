/** Portable mem-search contract. Keep the worker copy byte-for-byte identical. */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface MemoryIndexRow {
  id: string;
  kind: "observation" | "summary" | "prompt";
  project: string;
  title: string;
  createdAt: number | null;
  type: string | null;
}
export interface MemoryDetail extends MemoryIndexRow {
  content: string;
  truncated: boolean;
}
export interface ProgressiveSearchInput {
  mode?: "guided" | "auto";
  query?: string;
  project?: string;
  limit?: number;
  maxDetails?: number;
  depthBefore?: number;
  depthAfter?: number;
  continuation?: string;
  selectedIds?: (string | number)[];
}
export interface ProgressiveBackend {
  search(input: { query: string; project?: string; limit: number }): Promise<MemoryIndexRow[]>;
  timeline(input: { anchor: MemoryIndexRow; depthBefore: number; depthAfter: number }): Promise<MemoryIndexRow[]>;
  fetch(refs: MemoryIndexRow[]): Promise<MemoryDetail[]>;
}
interface SearchOptions {
  query: string;
  project?: string;
  limit: number;
  maxDetails: number;
  depthBefore: number;
  depthAfter: number;
}
export interface SearchTrace {
  step: 1 | 2 | 3;
  operation: "search" | "timeline" | "fetch";
  count: number;
  query?: string;
}
interface ContinuationState {
  version: "1";
  scope: string;
  expiresAt: number;
  step: 2 | 3;
  options: SearchOptions;
  eligible: MemoryIndexRow[];
  trace: SearchTrace[];
}
export interface ProgressiveSearchResult {
  version: "1";
  mode: "guided" | "auto";
  strategy: "caller-selected" | "ranked-lexical";
  step: 1 | 2 | 3;
  label: string;
  query: string;
  project: string | null;
  complete: boolean;
  reason: string | null;
  index: MemoryIndexRow[];
  observations: MemoryDetail[];
  continuation: string | null;
  next: { tool: "mem_search"; arguments: ProgressiveSearchInput; instruction: string } | null;
  trace: SearchTrace[];
}
export class ProgressiveSearchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProgressiveSearchError";
  }
}
const TTL_MS = 15 * 60 * 1000;
export const PROGRESSIVE_RESPONSE_BYTES = 64 * 1024;
const TOKEN_BYTES = 48 * 1024;
const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");

function shortText(value: string, bytes: number): string {
  let result = "";
  let length = 0;
  for (const char of value) {
    const size = utf8Length(char);
    if (length + size > bytes) break;
    result += char;
    length += size;
  }
  return result;
}
function fail(code: string, message: string): never {
  throw new ProgressiveSearchError(code, message);
}
function integer(value: unknown, fallback: number, maximum: number, name: string, minimum = 1): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    fail("invalid_input", `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
function queryOptions(input: ProgressiveSearchInput): SearchOptions {
  if (typeof input.query !== "string") fail("invalid_input", "Start mem_search with a query.");
  const query = input.query.trim();
  if (!query || query.length > 500 || utf8Length(query) > 1024) {
    fail("invalid_input", "query must contain 1–500 characters and at most 1024 UTF-8 bytes.");
  }
  let project: string | undefined;
  if (input.project !== undefined) {
    if (typeof input.project !== "string" || !input.project.trim() || utf8Length(input.project.trim()) > 256) {
      fail("invalid_input", "project must be nonempty and at most 256 UTF-8 bytes.");
    }
    project = input.project.trim();
  }
  return {
    query, ...(project === undefined ? {} : { project }),
    limit: integer(input.limit, 20, 20, "limit"),
    maxDetails: integer(input.maxDetails, 3, 5, "maxDetails"),
    depthBefore: integer(input.depthBefore, 2, 3, "depthBefore", 0),
    depthAfter: integer(input.depthAfter, 2, 3, "depthAfter", 0),
  };
}
/** Discard bodies/snippets and invalid identities before any disclosure or signing. */
function indexRows(rows: MemoryIndexRow[], maximum: number): MemoryIndexRow[] {
  const ids = new Set<string>();
  const result: MemoryIndexRow[] = [];
  for (const row of rows) {
    const id = String(row.id);
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || ids.has(id)) continue;
    if (!["observation", "summary", "prompt"].includes(row.kind)) continue;
    if (typeof row.project !== "string" || utf8Length(row.project) > 256) continue;
    ids.add(id);
    result.push({
      id, kind: row.kind, project: row.project,
      title: shortText(String(row.title ?? "").replace(/[\u0000-\u001f]/g, " "), 240),
      createdAt: typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : null,
      type: row.type == null ? null : shortText(String(row.type), 64),
    });
    if (result.length >= maximum) break;
  }
  return result;
}
function selectedRows(input: ProgressiveSearchInput, eligible: MemoryIndexRow[], maximum: number): MemoryIndexRow[] {
  if (!Array.isArray(input.selectedIds) || input.selectedIds.length > maximum) {
    fail("selection_required", `Choose selectedIds from the last index (at most ${maximum}); [] ends the search.`);
  }
  const lookup = new Map(eligible.map(row => [row.id, row]));
  const rows: MemoryIndexRow[] = [];
  for (const value of input.selectedIds) {
    if ((typeof value !== "string" && typeof value !== "number") || (typeof value === "number" && !Number.isSafeInteger(value))) {
      fail("invalid_selection", "selectedIds must contain string IDs or safe integer IDs from the last index.");
    }
    const row = lookup.get(String(value));
    if (!row) fail("invalid_selection", "An ID was not disclosed by the preceding mem-search step.");
    if (!rows.some(item => item.id === row.id)) rows.push(row);
  }
  return rows;
}
const STOP_WORDS = new Set("a an and are as at be been by can did do for from had has have how i in is it last me memory my of on or our previous search session sessions that the their this to was we were what when where which who why with work you your".split(" "));
function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(word => !STOP_WORDS.has(word));
}
function relevance(row: MemoryIndexRow, words: string[]): number {
  const title = row.title.toLowerCase();
  const tokens = title.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.reduce((score, word) => score + (tokens.some(token => token === word || (word.length >= 5 && token.length >= 5 && token.slice(0, 5) === word.slice(0, 5))) ? 1 : 0), 0);
}
function ranked(rows: MemoryIndexRow[], query: string, maximum: number): MemoryIndexRow[] {
  const words = terms(query);
  return rows.map((row, position) => ({ row, position, score: relevance(row, words) }))
    .filter(item => item.score > 0 && item.row.kind !== "prompt")
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .slice(0, maximum).map(item => item.row);
}

export class ProgressiveSearch {
  private readonly now: () => number;
  constructor(private readonly backend: ProgressiveBackend, private readonly options: {
    secret: string | Uint8Array; scope: string; now?: () => number;
  }) {
    if (options.secret.length < 32 || !options.scope || utf8Length(options.scope) > 2048) {
      throw new Error("Progressive search requires a signing secret and a bounded nonempty scope.");
    }
    this.now = options.now ?? Date.now;
  }
  private signature(body: string): Buffer {
    return createHmac("sha256", this.options.secret).update("cmem:mem-search:v1\0").update(body).digest();
  }
  private encode(state: ContinuationState): string {
    const body = Buffer.from(JSON.stringify(state)).toString("base64url");
    const token = `${body}.${this.signature(body).toString("base64url")}`;
    if (utf8Length(token) > TOKEN_BYTES) fail("response_too_large", "The search context exceeds its continuation budget. Narrow the query.");
    return token;
  }
  private decode(token: unknown): ContinuationState {
    if (typeof token !== "string" || utf8Length(token) > TOKEN_BYTES || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) {
      fail("invalid_continuation", "Invalid mem-search continuation. Restart with a query.");
    }
    const [body, signature] = token.split(".");
    const actual = Buffer.from(signature, "base64url");
    const expected = this.signature(body);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail("invalid_continuation", "Invalid mem-search continuation. Restart with a query.");
    let state: ContinuationState;
    try { state = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
    catch { return fail("invalid_continuation", "Invalid mem-search continuation. Restart with a query."); }
    if (state.version !== "1" || state.scope !== this.options.scope || ![2, 3].includes(state.step)) {
      fail("invalid_continuation", "This continuation belongs to a different memory scope. Restart with a query.");
    }
    if (!Number.isFinite(state.expiresAt) || state.expiresAt <= this.now()) fail("expired_continuation", "Mem-search continuation expired. Restart with a query.");
    return state;
  }
  private result(mode: "guided" | "auto", step: 1 | 2 | 3, options: SearchOptions, index: MemoryIndexRow[], trace: SearchTrace[], state?: ContinuationState, observations: MemoryDetail[] = [], reason: string | null = null): ProgressiveSearchResult {
    // State and visible index share the same retained rows. A bounded response
    // may drop tail rows, but never signs undisclosed identities.
    let continuation: string | null = null;
    if (state) {
      for (;;) {
        try { continuation = this.encode(state); break; }
        catch (error) {
          if (!(error instanceof ProgressiveSearchError) || error.code !== "response_too_large" || index.length <= 1) throw error;
          index.pop();
          state.eligible = index;
          reason = "index_truncated";
        }
      }
    }
    const next = state ? {
      tool: "mem_search" as const,
      arguments: { mode: "guided" as const },
      instruction: state.step === 2
        ? `mem-search step 2 of 3: review titles, choose at most ${options.maxDetails} anchor IDs from this index, then call mem_search with this response's continuation and selectedIds to inspect their timelines. Do not fetch full observations yet.`
        : `mem-search step 3 of 3: use these timelines to discard unrelated rows, then call mem_search with this response's continuation and at most ${options.maxDetails} selectedIds to fetch details in one batch. Prompts are context only.`,
    } : null;
    const result: ProgressiveSearchResult = {
      version: "1", mode, strategy: mode === "auto" ? "ranked-lexical" : "caller-selected",
      step, label: `mem-search step ${step} of 3`, query: options.query,
      project: options.project ?? null, complete: !state, reason, index, observations, continuation, next, trace,
    };
    // Control characters can expand sixfold in JSON. Enforce the serialized wire
    // size, preserve every selected row's identity, and mark shortened bodies.
    while (utf8Length(JSON.stringify(result)) > PROGRESSIVE_RESPONSE_BYTES) {
      if (state && index.length > 1) {
        index.pop();
        state.eligible = index;
        result.continuation = this.encode(state);
        result.reason = "index_truncated";
        continue;
      }
      const largest = [...observations].sort((a, b) => b.content.length - a.content.length)[0];
      if (!largest || !largest.content.length) fail("response_too_large", "The search context exceeds its response budget. Narrow the query.");
      largest.content = shortText(largest.content, Math.max(0, Math.floor(utf8Length(largest.content) / 2)));
      largest.truncated = true;
    }
    return result;
  }
  private async context(anchors: MemoryIndexRow[], options: SearchOptions): Promise<MemoryIndexRow[]> {
    const rows: MemoryIndexRow[] = [];
    // Backend queries stay sequential to keep database load bounded.
    for (const anchor of anchors) {
      const neighbors = indexRows(await this.backend.timeline({ anchor, depthBefore: options.depthBefore, depthAfter: options.depthAfter }), 7);
      // Context never crosses the selected anchor's project; adapters must also
      // enforce their authenticated owner scope on every lookup.
      rows.push(...neighbors.filter(row => row.project === anchor.project));
    }
    return indexRows(rows, 35);
  }
  private async details(refs: MemoryIndexRow[]): Promise<MemoryDetail[]> {
    const fetchable = refs.filter(row => row.kind !== "prompt");
    if (!fetchable.length) return [];
    const fetched = await this.backend.fetch(fetchable);
    return fetchable.flatMap(ref => {
      const row = fetched.find(item => String(item.id) === ref.id && item.kind === ref.kind && item.project === ref.project);
      if (!row || typeof row.content !== "string") return [];
      const content = shortText(row.content, 8 * 1024);
      return [{ ...ref, content, truncated: Boolean(row.truncated) || content !== row.content }];
    });
  }
  async run(input: ProgressiveSearchInput): Promise<ProgressiveSearchResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid_input", "mem_search requires an object input.");
    if (input.mode !== undefined && input.mode !== "guided" && input.mode !== "auto") fail("invalid_input", "mode must be guided or auto.");
    const mode = input.mode ?? "guided";
    if (input.continuation !== undefined) {
      if (mode !== "guided") fail("invalid_input", "Continuations use guided mode.");
      const state = this.decode(input.continuation);
      for (const key of ["query", "project", "limit", "maxDetails", "depthBefore", "depthAfter"] as const) {
        if (input[key] !== undefined && input[key] !== state.options[key]) fail("scope_changed", "Keep the original search options when continuing, or restart with a query.");
      }
      const refs = selectedRows(input, state.eligible, state.options.maxDetails);
      if (!refs.length) return this.result(mode, state.step, state.options, [], state.trace, undefined, [], "caller_stopped");
      if (state.step === 2) {
        const context = await this.context(refs, state.options);
        const trace = [...state.trace, { step: 2 as const, operation: "timeline" as const, count: context.length }];
        return this.result(mode, 2, state.options, context, trace, context.length ? { ...state, step: 3, eligible: context, trace } : undefined, [], context.length ? null : "context_not_found");
      }
      if (refs.some(row => row.kind === "prompt")) fail("invalid_selection", "Prompts supply timeline context; select observation or summary IDs for details.");
      const observations = await this.details(refs);
      return this.result(mode, 3, state.options, refs, [...state.trace, { step: 3, operation: "fetch", count: observations.length }], undefined, observations, observations.length ? null : "details_not_found");
    }
    if (input.selectedIds !== undefined) fail("invalid_input", "selectedIds requires the preceding step's continuation.");
    const options = queryOptions(input);
    let index = indexRows(await this.backend.search(options), options.limit);
    const trace: SearchTrace[] = [{ step: 1, operation: "search", count: index.length, query: options.query }];
    if (mode === "guided") {
      return this.result(mode, 1, options, index, trace, index.length ? {
        version: "1", scope: this.options.scope, expiresAt: this.now() + TTL_MS,
        step: 2, options, eligible: index, trace,
      } : undefined, [], index.length ? null : "no_results");
    }
    let anchors = ranked(index, options.query, options.maxDetails);
    // One bounded query refinement; no hidden model call or unbounded retries.
    const refined = terms(options.query).join(" ");
    if (!anchors.length && refined && refined !== options.query) {
      const refinedIndex = indexRows(await this.backend.search({ ...options, query: refined }), options.limit);
      trace.push({ step: 1, operation: "search", count: refinedIndex.length, query: refined });
      anchors = ranked(refinedIndex, options.query, options.maxDetails);
      // Semantic hits remain useful to the caller even when title matching or
      // query refinement cannot select them automatically.
      index = indexRows(anchors.length ? [...refinedIndex, ...index] : [...index, ...refinedIndex], options.limit);
    }
    if (!anchors.length) return this.result(mode, 1, options, index, trace, index.length ? {
      version: "1", scope: this.options.scope, expiresAt: this.now() + TTL_MS,
      step: 2, options, eligible: index, trace,
    } : undefined, [], index.length ? "no_relevant_candidates" : "no_results");
    const context = await this.context(anchors, options);
    trace.push({ step: 2, operation: "timeline", count: context.length });
    const selected = ranked(context, options.query, options.maxDetails);
    if (!selected.length) return this.result(mode, 2, options, context, trace, undefined, [], "no_relevant_context");
    const observations = await this.details(selected);
    trace.push({ step: 3, operation: "fetch", count: observations.length });
    return this.result(mode, 3, options, selected, trace, undefined, observations, observations.length ? null : "details_not_found");
  }
}

export function progressiveSearchToolResult(result: ProgressiveSearchResult) {
  const content: [{ type: "text"; text: string }] = [{ type: "text", text: JSON.stringify(result) }];
  return { content, structuredContent: { ...result } };
}
export function progressiveSearchToolError(error: unknown) {
  // Backend exceptions may contain credentials or SQL. Only contract errors are
  // safe to disclose; adapters log backend errors through their own safe logger.
  const result = {
    version: "1",
    error: error instanceof ProgressiveSearchError ? { code: error.code, message: error.message } : { code: "backend_error", message: "Memory retrieval failed. Retry the query." },
    next: { tool: "mem_search", arguments: { mode: "guided" }, instruction: "Restart mem_search with a query; follow search → timeline → filtered details." },
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: true as const };
}
