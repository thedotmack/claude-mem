import type { SearchOptions } from '../sqlite/types.js';
import type { DeepSearchResult } from '../sqlite/tool-use-search.js';

// Set from a real-corpus measurement (2026-11-09, Bun 1.4.4, macOS arm64, a
// busy machine): 276,904 tool uses, 2.0 GB stored input + response, 21 runs
// per query through searchToolUses on the built index, plus the real child's
// startup against the same 3.4 GB file (p95 85 ms).
//   common term, all projects:   median 993 ms, p95 3,391 ms (half over 1 s)
//   CJK hit, all projects:       median 1,732 ms, p95 3,508 ms
//   scoped common term / CJK miss: p95 379 / 449 ms; rare-term miss: ~0 ms
//   CJK miss, all projects:      median 5,368 ms, p95 12,791 ms (full scan)
// 4 s covers the all-projects common-term and CJK-hit p95 plus child startup
// (3,593 ms worst). The query runs in its own disposable read-only process,
// so the shared context reader is never held for it. A global CJK miss and a
// first query on a cold page cache (~15 s) still expire: that comes back as
// an explicit timeout (complete:false), never as zero hits.
export const DEEP_SEARCH_DEADLINE_MS = 4000;
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
