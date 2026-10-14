// CLAUDE_MEM_SKIP_TOOLS matching, shared by every capture path so the setting
// means the same thing whichever runtime the user picked:
//   - the worker ingest path (src/services/worker/http/shared.ts), and
//   - the hook handlers' server-runtime branches (observation.ts, file-edit.ts),
//     which send events straight to the server and never pass through worker
//     ingest.
//
// Matching is case-insensitive, because hosts spell the same tool differently
// and adapters rename some (OpenCode's `read` arrives as `Read`). A user's
// `read` or `Read` entry keeps matching either way.

export function isToolSkipped(toolName: string, skipToolsSetting: string | undefined): boolean {
  if (!skipToolsSetting) return false;
  const skipTools = new Set(
    skipToolsSetting.split(',').map(tool => tool.trim().toLowerCase()).filter(Boolean)
  );
  return skipTools.has(toolName.toLowerCase());
}
