// Run with a provisioned native tree-sitter CLI and the repository dependencies:
// bun scripts/bench-smart-read-containers.ts [absolute/parser.ts] [class counts...]
// Supplying another checkout's parser compares the same input with that version.
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const modulePath = process.argv[2] ?? fileURLToPath(new URL('../src/services/smart-file-read/parser.ts', import.meta.url));
const { parseFile } = await import(pathToFileURL(modulePath).href);
const sizes = process.argv.slice(3).map(Number);
parseFile('class Warm { one() { return 1; } }', 'containers.ts');
for (const count of sizes.length ? sizes : [500, 2000, 5000]) {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Class counts must be positive integers');
  const content = Array.from({ length: count }, (_, index) =>
    `class Item${index} { first() { return ${index}; } second() { return ${index + 1}; } }`).join('\n');
  const samples: number[] = [];
  let digest = '';
  for (let sample = 0; sample < 3; sample++) {
    const start = performance.now();
    const file = parseFile(content, 'containers.ts');
    samples.push(performance.now() - start);
    if (file.symbols.length !== count || file.symbols.some((item: { children?: unknown[] }) => item.children?.length !== 2)) {
      throw new Error(`Unexpected outline for ${count} classes: ${file.symbols.length} roots`);
    }
    const current = createHash('sha256').update(JSON.stringify(file)).digest('hex');
    if (digest && digest !== current) throw new Error('Non-deterministic outline');
    digest = current;
  }
  console.log(JSON.stringify({ count, sourceBytes: Buffer.byteLength(content), samplesMs: samples,
    medianMs: [...samples].sort((a, b) => a - b)[1], sha256: digest }));
}
