// Per-call working directory for the MCP tool handlers.
//
// Over stdio the MCP server is a child of one client, started in that client's
// workspace, so process.cwd() is the project. Over HTTP one process serves many
// clients; each session carries its own cwd and the tool handlers read it here.
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<{ cwd: string }>();

/** Run `fn` (and everything it awaits) with `cwd` as the current project directory. */
export function runWithCwd<T>(cwd: string, fn: () => T): T {
  return storage.run({ cwd }, fn);
}

/** The project directory for the running tool call: the session's cwd, else the process cwd. */
export function getRequestCwd(): string {
  return storage.getStore()?.cwd ?? process.cwd();
}
