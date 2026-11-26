// Setup keeps imported transcript turns for inference on this device. Live hook
// turns have a null native identity or a host-specific identity without this prefix.
export function syncablePromptSql(column) {
  return `(${column} IS NULL OR ${column} NOT GLOB 'transcript:*')`;
}
