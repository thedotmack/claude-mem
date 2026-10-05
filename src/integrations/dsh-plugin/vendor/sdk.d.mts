/** Types for the three pinned SDK helpers; runtime comes from sdk.mjs. */
import type { ContentBlock, UserMessage } from '../sdk-contract.js';
export class Schema<T = unknown> {
  static object(fields: Record<string, Schema>): Schema<any>;
  static string(): Schema<string>;
  static number(): Schema<number>;
  static boolean(): Schema<boolean>;
  static array(value: Schema): Schema<unknown[]>;
  default(value: unknown): this;
}
export function createUserMessage(input: {
  content: ContentBlock[]; source: { kind: string; plugin?: string };
}): UserMessage;
export function defineTool<T>(options: {
  name: string; description: string; parameters: Record<string, unknown>;
  output: { schema: Record<string, unknown>; render(args: any, value: T): unknown };
  timeoutMs: number; isConcurrencySafe: () => boolean;
  execute(args: any, execution: { signal?: AbortSignal }): Promise<T>;
}): unknown;
