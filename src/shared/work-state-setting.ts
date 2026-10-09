/**
 * CLAUDE_MEM_WORK_STATE_ENABLED: on unless set to 'false'. Off, SessionStart
 * carries no work-state section and the MCP server offers no work_state_*
 * tools, so a host that tracks work its own way is not told to use them (#4606).
 */
export function isWorkStateEnabled(value: string | undefined): boolean {
  return String(value ?? '').trim().toLowerCase() !== 'false';
}
