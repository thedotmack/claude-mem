/**
 * claude-mem memory provider for eve agents (https://eve.dev).
 *
 * Talks to the hosted claude-mem MCP endpoint (https://cmem.ai/api/mcp) with
 * a cmem.ai key from https://cmem.ai/pro/key:
 * - recall: before every turn, one `dumb_search` for the user's message
 *   (index -> context -> details in one call; no inference spend).
 * - tools: `search` (same lookup, model-driven) and `remember` (save_memory).
 * - capture: none. Hosted save_memory gives every call a fresh ID, so a
 *   replayed eve operation would save twice. Without a replay-safe write,
 *   automatic capture stays off; the model saves deliberately with `remember`.
 */
import type { MemoryProvider, MemoryScope } from "eve/memory";
export declare const CLAUDE_MEM_DEFAULT_BASE_URL = "https://cmem.ai";
export interface ClaudeMemOptions {
    /** cmem.ai key from https://cmem.ai/pro/key. Saving needs a key with write access. */
    apiKey: string | undefined;
    /**
     * claude-mem project that `remember` saves into and that recall and `search`
     * read from. Default: one project per eve memory scope (`eve-<sha256 of the
     * scope key>`), so separate callers never share memory.
     *
     * A fixed name shares one project across every scope. Use it only when every
     * caller the slot's scope admits is the owner of `apiKey`.
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
    /** Override for tests or a staging origin. Default https://cmem.ai. */
    baseUrl?: string;
}
/** The claude-mem project for one eve scope: fixed when configured, else derived from the scope key. */
export declare function projectForScope(scope: Pick<MemoryScope, "key">, fixedProject?: string): string;
export declare function claudeMem(options: ClaudeMemOptions): MemoryProvider;
