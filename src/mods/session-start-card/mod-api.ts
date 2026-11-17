/**
 * The slice of Claude Code's mods API that the session-start card uses, typed
 * by hand. The full declarations ship with Claude Code (`/plugin-types`, or
 * mods/types/claude-code.d.ts in anthropics/claude-code); these match them.
 */

/** What an element constructor builds; only Claude Code reads it. */
export type RenderNode = unknown;
type RenderChild = RenderNode | string | readonly RenderChild[];

/** One of the element constructors `$.ui.resolve(e)` hands a render hook. */
export type ElementConstructor = (props: Record<string, unknown>) => RenderNode;

/** `h`, a global of a hooks module: what JSX compiles to there. */
export type ElementFactory = (
  element: ElementConstructor,
  props: Record<string, unknown> | null,
  ...children: RenderChild[]
) => RenderNode;

/** What `$.ui.place` resolves to. With a `requestId` the row stands in the conversation, drawn or not. */
export type PlacedRowResult =
  | { isPlaced: true; requestId: string }
  | { isPlaced: false; requestId?: string; reason: string };

export interface ModApi {
  /** This plugin, as loaded. */
  plugin: { name: string };
  env: { get(name: string): Promise<string | undefined> };
  fs: {
    read(path: string): Promise<string>;
    exists(path: string): Promise<boolean>;
  };
  session: { version(): Promise<{ version: string; base?: string }> };
  /** The variables a command hook of this plugin gets; CLAUDE_PLUGIN_DATA is the plugin's data folder. */
  process: { hookEnv(): Promise<Record<string, string>> };
  clock: { now(): Promise<number> };
  ui: {
    place(row: { id: string }): Promise<PlacedRowResult>;
    invalidate(event: 'ui.render'): void;
    log(text: string): void;
    resolve(e: PlacedRenderEvent): { Box: ElementConstructor; Text: ElementConstructor };
  };
}

/** `classic.SessionStart`: what a SessionStart command hook gets on stdin. A key a hook adds reaches the command hooks too. */
export interface ClassicSessionStartEvent {
  session_id: string;
  source: string;
  [key: string]: unknown;
}

/** `ui.render` for a row some plugin placed with `$.ui.place`. */
export interface PlacedRenderEvent {
  surface: string;
  props: { id: string; plugin: string };
  [key: string]: unknown;
}

type Next<E, R> = (e: E) => Promise<R>;
type Hook<E, R> = ($: ModApi, e: E, next: Next<E, R>) => Promise<R>;

/** What `on(...)` returns. In `.catch(handler)`, `next(e)` passes the event on as if the hook were absent. */
export interface Registration<E, R> {
  catch(handler: Hook<E, R>): void;
}

export interface On {
  (event: 'classic.SessionStart', hook: Hook<ClassicSessionStartEvent, unknown>): Registration<ClassicSessionStartEvent, unknown>;
  (event: 'session.start', matcher: { isInteractive: true }, hook: Hook<unknown, unknown>): Registration<unknown, unknown>;
  (event: 'ui.render', matcher: { component: 'Placed' }, hook: Hook<PlacedRenderEvent, RenderNode>): Registration<PlacedRenderEvent, RenderNode>;
}
