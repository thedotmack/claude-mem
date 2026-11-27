// Setup keeps imported transcript turns for inference on this device. Live hook
// turns have a null native identity or a host-specific identity without this prefix.
// Without an account context, publication remains closed to imported transcript turns.
export function syncablePromptSql(column, accountSql) {
  const live = `(${column} IS NULL OR ${column} NOT GLOB 'transcript:*')`;
  if (accountSql === undefined) return live;
  const grant = column.replace(/native_prompt_id$/, 'workspace_sync_account');
  return `((${grant} IS NULL AND ${live}) OR ${grant} = ${accountSql})`;
}

// Read-only consumers may open a database before the new worker migrates it.
export function workspaceAccountSql(db, account) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('user_prompts') WHERE name = 'workspace_sync_account'").get()) return undefined;
  return db.prepare('SELECT quote(?) AS value').get(account || null).value;
}
