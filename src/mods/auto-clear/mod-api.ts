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
    append(input: SessionAppendInput): Promise<unknown>;
  };
  prompt: { submit(input: { text: string; asUser?: boolean }): Promise<unknown> };
  command: { run(input: { command: string; args?: string }): Promise<unknown> };
  ui: { log(text: string): void };
  clock: {
    now(): Promise<number>;
    after(ms: number, fn: () => void): unknown;
  };
}

/** One block of a message as the Messages API spells it. */
export interface ApiContentBlock {
  type: string;
  [field: string]: unknown;
}

/**
 * `session.append` for a tool result (`door: 'tool-result'`): the row as it will
 * be kept. Everything but `message.content` is pinned.
 */
export interface SessionAppendEvent {
  message: { type: string; content: ApiContentBlock[] };
  door: string;
  /** For a tool result `{ kind: 'tool', tool }`: the full tool name, or `unknown` when no call matches the row. */
  origin: { kind: string; tool?: string; [field: string]: unknown };
  uuid: string;
  /** Set for a subagent's conversation; absent on main. */
  agentId?: string;
}

/** What `next(e)` resolves to at `session.append`: the row as stored. */
export interface SessionAppendResult {
  message: { type: string; content: ApiContentBlock[] };
  uuid: string;
}

/** `$.session.append`: a row the model reads and the person does not see as typed. */
export interface SessionAppendInput {
  message: { type: 'user'; content: Array<{ type: 'text'; text: string }> };
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
  (
    event: 'session.append',
    matcher: { door: 'tool-result' },
    hook: Hook<SessionAppendEvent, SessionAppendResult>,
  ): Registration<SessionAppendEvent, SessionAppendResult>;
  (event: 'turn.start', hook: Hook<unknown, unknown>): Registration<unknown, unknown>;
  (event: 'turn.complete', hook: Hook<TurnCompleteEvent, unknown>): Registration<TurnCompleteEvent, unknown>;
}
