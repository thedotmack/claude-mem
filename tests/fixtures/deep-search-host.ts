import { deepSearchRuntimeSupported } from '../../src/services/deep-search/runtime-support.js';
import { DeepSearchClient } from '../../src/services/deep-search/DeepSearchClient.js';

// This entry is bundled/compiled with the release build plugins. The child must
// launch from a self-contained executable with no source tree or dependencies.
async function main() {
  const request = JSON.parse(await Bun.stdin.text());
  // Simulate an old embedded runtime without installing another Bun. The
  // executable's real virtual entry path is still used by capability detection.
  const client = new DeepSearchClient(request.dbPath, { deadlineMs: request.deadlineMs ?? 1000,
    runtimeSupported: request.runtimeVersion ? () => deepSearchRuntimeSupported(request.runtimeVersion) : undefined });
  try { console.log(JSON.stringify(await client.search(request.query, request.options))); }
  finally { await client.close(); }
}
main().catch(() => { process.exitCode = 1; });
