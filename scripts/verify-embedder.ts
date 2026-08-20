/**
 * Real-model smoke check for the vector index.
 *
 * Kept out of `bun test` on purpose: it downloads and initialises the ONNX
 * runtime, and on Bun 1.3.8 a process holding that native module panics during
 * teardown, which fails the run even when every assertion passed. The suite
 * uses tests/vector/fake-embedder.ts instead.
 *
 * Run manually:  bun run scripts/verify-embedder.ts
 */
import { LocalEmbedder } from '../src/services/vector/LocalEmbedder.js';

const embedder = new LocalEmbedder();
const t0 = Date.now();
const [a, b, c] = await embedder.embed([
  'two agents wrote the same file at once and one write was lost',
  'concurrent writers clobbered a shared store',
  'the CSS gradient on the landing page needed adjusting',
]);
const dot = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * y[i], 0);

console.log(`dims: ${a.length} (expected 384)`);
console.log(`cold start + 3 embeds: ${Date.now() - t0}ms`);
console.log(`related pair   : ${dot(a, b).toFixed(3)}`);
console.log(`unrelated pair : ${dot(a, c).toFixed(3)}`);

if (a.length !== 384) throw new Error(`expected 384 dims, got ${a.length}`);
if (dot(a, b) <= dot(a, c)) throw new Error('related pair should score above unrelated pair');
console.log('OK — real model produces 384-dim vectors with sane relative ordering');
