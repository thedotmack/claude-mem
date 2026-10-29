/**
 * Sent on every sync hub request. `quarantine-unknown-kinds`: when a pull
 * meets an op whose kind this client does not know, SyncApply sets it aside in
 * sync_pull_quarantine and moves the cursor past it, instead of retrying the
 * same page forever (true since v13.29.0). The hub records it per device and
 * lists `work_state` in `content_kinds` for an account once every active
 * device has said so (claude-mem-pro drizzle, cmem_sync_status).
 */
export const SYNC_CAPABILITIES_HEADER = 'X-Sync-Capabilities';
export const SYNC_CAPABILITIES = 'quarantine-unknown-kinds';
