/**
 * The slice of Claude Code's mods API that the auto-clear mod uses, typed by
 * hand. The full declarations ship with Claude Code (`/plugin-types`, or
 * mods/types/claude-code.d.ts in anthropics/claude-code); these match them.
 */

export interface ModApi {
  env: { get(name: string): Promise<string | undefined> };
  fs: {
    read(path: string): Promise<string>;
    exists(path: string): Promise<boolean>;
  };
  session: {
    usage(): Promise<{ context: { tokens?: number; window: number; percent?: number } }>;
    surfaces(): Promise<readonly string[]>;
  };
  prompt: { submit(input: { text: string; asUser?: boolean }): Promise<unknown> };
  command: { run(input: { command: string; args?: string }): Promise<unknown> };
  ui: { log(text: string): void };
  clock: {
    now(): Promise<number>;
    after(ms: number, fn: () => void): unknown;
  };
}

/** `tool.call`: the tool's name, its arguments beside it, and `agentId` inside a subagent. */
export interface ToolCallEvent {
  tool: string;
  agentId?: string;
  [argument: string]: unknown;
}

/** What `next(e)` resolves to at `tool.call`: the result, or a refusal. */
export interface ToolCallResult {
  deny?: string;
  result?: unknown;
  text?: string;
  isError?: boolean;
  context?: readonly string[];
  [key: string]: unknown;
}

export interface TurnCompleteEvent {
  agentId?: string;
  isAborted: boolean;
  reason: string;
}

type Next<E, R> = (e: E) => Promise<R>;
type Hook<E, R> = ($: ModApi, e: E, next: Next<E, R>) => Promise<R>;

/**
 * What `on(...)` returns. `.catch(handler)` runs when the hook throws or
 * overruns; there `next(e)` replays the hook's own call if it made one, so
 * `next(e)` passes the event through as if the hook were absent.
 */
export interface Registration<E, R> {
  catch(handler: Hook<E, R>): void;
}

export interface On {
  (event: 'session.start', hook: Hook<unknown, unknown>): Registration<unknown, unknown>;
  (event: 'session.end', hook: Hook<unknown, unknown>): Registration<unknown, unknown>;
  (event: 'tool.call', hook: Hook<ToolCallEvent, ToolCallResult>): Registration<ToolCallEvent, ToolCallResult>;
  (event: 'turn.start', hook: Hook<unknown, unknown>): Registration<unknown, unknown>;
  (event: 'turn.complete', hook: Hook<TurnCompleteEvent, unknown>): Registration<TurnCompleteEvent, unknown>;
}
