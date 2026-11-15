// Compare the raw tool-capture write path in fresh Bun processes.
// bun scripts/bench-tool-payload-capture.ts [absolute/tool-uses.ts] [payload bytes] [writes]
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const modulePath = process.argv[2] ?? fileURLToPath(new URL('../src/services/sqlite/tool-uses.ts', import.meta.url));
const bytes = Number(process.argv[3] ?? 4 * 1024 * 1024);
const writes = Number(process.argv[4] ?? 32);
if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % 8 !== 0
  || !Number.isSafeInteger(writes) || writes <= 0) {
  throw new Error('Payload bytes must be a positive multiple of eight; writes must be a positive integer');
}
const { createToolUsesSchema, upsertToolUse } = await import(pathToFileURL(modulePath).href);
const db = new Database(':memory:');
createToolUsesSchema(db);
// Eight UTF-8 bytes per repetition, covering three- and four-byte characters.
const payload = '漢🙂x'.repeat(bytes / 8);
const input = { contentSessionId: 'capture-benchmark', project: 'capture-benchmark', toolName: 'Bash',
  toolInput: '{"command":"cat owned-large-output.txt"}', toolResponse: payload };
upsertToolUse(db, { ...input, toolUseId: 'warm', toolResponse: 'small warmup', createdAtEpoch: 1700000000000 });
db.run('DELETE FROM tool_uses');
const cpuStart = process.cpuUsage();
const start = performance.now();
for (let index = 0; index < writes; index++) {
  upsertToolUse(db, { ...input, toolUseId: `call-${index}`, createdAtEpoch: 1700000000000 + index });
}
const milliseconds = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
const maxRssKiB = process.resourceUsage().maxRSS;
const rows = db.query('SELECT tool_use_id, tool_input, tool_response, content_hash, created_at_epoch FROM tool_uses ORDER BY id').all();
const sha256 = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
db.close();
console.log(JSON.stringify({ payloadBytes: Buffer.byteLength(payload), writes, milliseconds,
  cpuMilliseconds: (cpu.user + cpu.system) / 1000, maxRssKiB, sha256 }));
