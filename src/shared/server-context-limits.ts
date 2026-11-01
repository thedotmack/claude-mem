// SPDX-License-Identifier: Apache-2.0
//
// Row limits for POST /v1/context, shared by the server route that enforces them
// and the hook-side client that requests them.

/** Most rows one request may ask for: the CLAUDE_MEM_CONTEXT_OBSERVATIONS range (1-200). */
export const SERVER_CONTEXT_MAX_LIMIT = 200;

/** Rows returned by a query-less (recency) request with no limit: the CLAUDE_MEM_CONTEXT_OBSERVATIONS default. */
export const SERVER_CONTEXT_RECENT_DEFAULT_LIMIT = 50;

/** Rows returned by a relevance (query) request with no limit. */
export const SERVER_CONTEXT_QUERY_DEFAULT_LIMIT = 10;
