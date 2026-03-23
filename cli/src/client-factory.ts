/**
 * Client factory — resolves the appropriate memory backend.
 *
 * Today: always returns WorkerClient.
 * Future: inspects config.backend to return SQLiteClient, Mem0Client, etc.
 */

import type { CMEMConfig } from './config.js';
import type { IMemoryClient } from './memory-client.js';
import { WorkerClient } from './client.js';

export function createMemoryClient(config: CMEMConfig): IMemoryClient {
  // For now, only the HTTP worker backend is supported.
  // Future backends will be selected via config.backend field.
  return new WorkerClient(config);
}
