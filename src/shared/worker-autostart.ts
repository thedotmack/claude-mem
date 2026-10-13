/**
 * CLAUDE_MEM_WORKER_AUTOSTART=false means the worker is managed externally (a
 * process manager, a container, `worker-service.cjs --daemon`). Hooks, the MCP
 * server and `start` then use a worker that is already running but never
 * launch, kill or recycle one. Any value other than "false" keeps the default.
 *
 * Pure so every caller can pass its own settings source (the hooks' cached
 * read, or a fresh read of settings.json in long-lived processes).
 */
export function isWorkerAutostartDisabled(settings: { CLAUDE_MEM_WORKER_AUTOSTART?: string }): boolean {
  return (settings.CLAUDE_MEM_WORKER_AUTOSTART ?? 'true').trim().toLowerCase() === 'false';
}
