/**
 * claude-mem memory provider for eve agents (https://eve.dev).
 *
 * Talks to hosted claude-mem (https://cmem.ai) with a cmem.ai key from
 * https://cmem.ai/pro/key:
 * - session context: before every turn, the newest memory from `timeline`
 *   (free), like Claude Code's SessionStart injection. It keeps one message ID,
 *   so each turn's copy replaces the previous one instead of piling up.
 * - recall: before every turn, one `dumb_search` for the user's message (free).
 * - tools: `search`, `timeline`, `get_observations` (the three-layer search the
 *   other claude-mem clients use, all free) and `remember` (save_memory).
 * - capture: after every completed turn, one live handoff to
 *   `/api/hooks/ingest`: the prompt, one observation per tool call, and a
 *   summary request, with secret-shaped text redacted before anything is
 *   sent (the Cowork client's patterns). Hosted claude-mem turns those into memory on the key
 *   owner's inference allowance. Each request is sent once, with no retry,
 *   spool, or queue: a failed send is reported with what was and was not
 *   accepted, and the rest of that turn is not recorded. Replays are
 *   deduplicated by the turn and tool call IDs and by an idempotency key
 *   derived from eve's `operationId`.
 */
import type { MemoryProvider, MemoryScope } from "eve/memory";
export declare const CLAUDE_MEM_DEFAULT_BASE_URL = "https://cmem.ai";
export interface ClaudeMemOptions {
    /** cmem.ai key from https://cmem.ai/pro/key. Saving and capture need a key with write access. */
    apiKey: string | undefined;
    /**
     * claude-mem project that `remember` and capture save into and that recall
     * and the tools read from. Default: one project per eve memory scope
     * (`eve-<sha256 of the scope key>`), so separate callers never share memory.
     *
     * A fixed name shares one project across every scope. Use it only when every
     * caller the slot's scope admits is the owner of `apiKey`. With capture on,
     * it must match `^[A-Za-z0-9_.-]{1,128}$` (the hosted ingest rule).
     */
    project?: string;
    /**
     * Read every project the key can see instead of only `project`, so the agent
     * recalls what you did in Claude Code, Codex, and other claude-mem clients.
     * Every caller admitted by the slot's scope can then read the key owner's
     * whole memory: enable it only for a single-owner agent whose scope returns
     * null for everyone else.
     */
    searchAllProjects?: boolean;
    /**
     * Record each completed turn (prompt, tool calls, summary) into claude-mem.
     * Default true. Each recorded tool call and each turn summary uses the key
     * owner's cmem.ai inference allowance. Set false to only read and `remember`.
     */
    capture?: boolean;
    /** Override for tests or a staging origin. Default https://cmem.ai. */
    baseUrl?: string;
}
/** The claude-mem project for one eve scope: fixed when configured, else derived from the scope key. */
export declare function projectForScope(scope: Pick<MemoryScope, "key">, fixedProject?: string): string;
export declare function claudeMem(options: ClaudeMemOptions): MemoryProvider;
