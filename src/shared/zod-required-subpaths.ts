/**
 * Subpath exports the bundled worker requires from `zod` (transitively, via
 * @modelcontextprotocol/sdk / @anthropic-ai/claude-agent-sdk). A stale/partial
 * install can leave the `zod` directory present while one of these subpath
 * exports fails to resolve — surfacing later as a runtime
 * `Cannot find module 'zod/...'` crash that prevents the worker from binding.
 *
 * Canonical source of truth. Both the install-time post-check
 * (setup-runtime.ts `verifyCriticalModules`) and the runtime worker preflight
 * (worker-utils.ts `checkInstalledWorkerDependencies`) import this so the two
 * guards can never drift out of sync. Version-agnostic: resolve subpaths, never
 * a pinned version.
 */
export const ZOD_REQUIRED_SUBPATHS = ['zod/v3', 'zod/v4', 'zod/v4-mini'] as const;
