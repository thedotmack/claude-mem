/**
 * The largest JSON request body the local worker parses; a bigger body is
 * refused with HTTP 413 before any route runs. It came down from 50 MB to 5 MiB
 * in the security hardening for #1935. The worker passes it to express.json
 * (src/services/worker/http/middleware.ts). Code that builds or forwards large
 * requests imports it rather than restating it: `claude-mem import` refuses a
 * record the worker cannot take before it writes anything, the MCP HTTP server
 * (src/servers/mcp-http.ts) refuses a larger tool call, and observation capture
 * (src/shared/media-ingress.ts) bounds an event under it.
 */
export const WORKER_JSON_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
