import { deepSearchRuntimeSupported } from '../../src/services/deep-search/runtime-support.js';
import { DeepSearchClient } from '../../src/services/deep-search/DeepSearchClient.js';

// This entry is bundled/compiled with the release build plugins. The child must
// launch from a self-contained executable with no source tree or dependencies.
async function main() {
  // Use the production child's referenced stdin stream and flushed stdout
  // transport for this short-lived probe, including Windows named pipes.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  // Simulate an old embedded runtime without installing another Bun. The
  // executable's real virtual entry path is still used by capability detection.
  const client = new DeepSearchClient(request.dbPath, { deadlineMs: request.deadlineMs ?? 1000,
    runtimeSupported: request.runtimeVersion ? () => deepSearchRuntimeSupported(request.runtimeVersion) : undefined });
  try {
    const output = JSON.stringify(await client.search(request.query, request.options));
    await new Promise<void>((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
  }
  finally { await client.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
