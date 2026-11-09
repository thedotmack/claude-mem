import type { SearchOptions } from '../sqlite/types.js';
import type { DeepSearchResult } from '../sqlite/tool-use-search.js';

// Initial synthetic baseline: common-term FTS 3.86 s, global CJK miss up to
// 6.008 s at 139,304 rows (Bun 1.3.13/macOS ARM64; see ADR capacity table).
// 1 s is a provisional interactive protection budget, not a real-corpus p95.
// Includes preparation/startup; expiry is explicit and never means zero hits.
export const DEEP_SEARCH_DEADLINE_MS = 1000;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_REPLY_BYTES = 128 * 1024;
export interface DeepSearchRequest {
  version: 1;
  id: number;
  parentPid: number;
  deadline: number;
  dbPath: string;
  query: string;
  options: SearchOptions;
}
export interface DeepSearchExecutor {
  search(query: string, options: SearchOptions): Promise<DeepSearchResult>;
}
