// Which work-state statuses close an item or a list. This is the one definition: the SessionStart section, the
// work_state_write and work_state_read replies, My Work and the owner-goals readers all ask here, so an item that one
// of them shows as open is open in all of them. The statuses an agent is told to write are in
// shared/memory-instructions.ts.
const CLOSED_STATUSES = new Set(['done', 'dropped']);

/** True when `status` closes its item or list, whatever its letter case. Any other value, or none, leaves it open. */
export const isClosedWorkStateStatus = (status) => status != null && CLOSED_STATUSES.has(String(status).toLowerCase());
