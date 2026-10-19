import type { ContextConfig, ContextInput } from './types.js';
import type { ContextInjectStats } from './ContextBuilder.js';
import type { WorkStateEntry } from '../sqlite/work-state.js';
import type { ModeConfig } from '../domain/types.js';

export interface ContextReadOptions {
  execution?: 'inline' | 'worker';
  reader?: ContextReadExecutor;
  config?: ContextConfig;
}

export interface ContextReadResult {
  text: string;
  stats: ContextInjectStats | null;
  readKeys?: string[];
}

export interface ContextRenderRequest {
  context?: ContextInput;
  forHuman: boolean;
  mode: ModeConfig;
  config: ContextConfig;
}

export interface ContextReadExecutor {
  render(request: ContextRenderRequest): Promise<ContextReadResult>;
}

export interface ContextReadMethods {
  render: {
    input: ContextRenderRequest;
    result: ContextReadResult;
  };
  readKeys: { input: { projects: string[] }; result: string[] };
  workState: { input: { projects: string[]; localDeviceId: string }; result: WorkStateEntry[] };
  hasObservations: { input: { projects: string[]; platformSource?: string }; result: boolean };
  projectsForCwd: { input: { cwd: string }; result: string[] };
}

export type ContextReadRequest = {
  [Method in keyof ContextReadMethods]: {
    id: number;
    method: Method;
    input: ContextReadMethods[Method]['input'];
  }
}[keyof ContextReadMethods];

export type ContextReadReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name: string; message: string } };
