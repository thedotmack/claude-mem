import type { Embedder } from '../../src/services/vector/types.js';

/**
 * Deterministic embedder for tests.
 *
 * The structural behaviour under test — scope joins, CASCADE, the content-hash
 * skip, backfill resumability — has nothing to do with which model produced a
 * vector. Loading the real ONNX runtime for those costs a 3s model init and a
 * 208MB native module per test file, needs a model download in CI, and (on Bun
 * 1.3.8) panics during process teardown with the native module loaded, which
 * poisons the exit code even when every assertion passed.
 *
 * Vectors are built by hashing each token into a dimension, so texts sharing
 * tokens land nearer each other. That makes ranking assertions hold by
 * construction rather than by trusting a model's judgement.
 *
 * Real-model behaviour is verified separately in scripts/verify-embedder.ts.
 */
export class FakeEmbedder implements Embedder {
  readonly modelId = 'test/fake-token-hash/384';
  readonly dims = 384;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const vec = new Float32Array(this.dims);
      for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) {
        let h = 2166136261;
        for (let i = 0; i < token.length; i++) {
          h ^= token.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        vec[Math.abs(h) % this.dims] += 1;
      }
      let norm = 0;
      for (const v of vec) norm += v * v;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
      return vec;
    });
  }
}
