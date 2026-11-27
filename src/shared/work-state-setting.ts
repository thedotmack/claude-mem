/**
 * CLAUDE_MEM_WORK_STATE_ENABLED: on unless set to 'false'. Off, SessionStart
 * carries no work-state section and the MCP server offers no work_state_*
 * tools, so a host that tracks work its own way is not told to use them (#4606).
 */
export function isWorkStateEnabled(value: string | undefined): boolean {
  return String(value ?? '').trim().toLowerCase() !== 'false';
}

/**
 * CLAUDE_MEM_WORK_STATE_BATCH_ENABLED: grouped `work_state_write` calls are a
 * strict opt-in. Only the exact lowercase string 'true' turns them on: unlike
 * the master switch above, a typo ('TRUE', '1') must silently keep the shipped
 * single-entry contract rather than change which tool arguments the host sees.
 */
export function isWorkStateBatchEnabled(value: string | undefined): boolean {
  return value === 'true';
}
