/** Structural public DSH host surface used by this plugin.
 * Host runtimes are supplied by DSH; only three pure public helpers are vendored.
 */
export interface ContentBlock { type: string; text?: string; [key: string]: unknown }
export interface UserMessage { role: 'user'; content: readonly ContentBlock[]; [key: string]: unknown }
export interface Agent {
  session: { id: string; header: { cwd?: string } };
  inject(message: UserMessage): unknown;
}
export interface ToolExecution { name: string; agent?: Agent }
export interface ToolExecutionResult { isError?: boolean; content: readonly ContentBlock[] }
export type PostToolDecision = unknown;
export interface Context {
  on(event: string, handler: (...args: any[]) => unknown): unknown;
  tools: { register(definition: unknown): unknown };
  skills: { register(skill: { name: string; description: string; source: string; content: string }): unknown };
}
