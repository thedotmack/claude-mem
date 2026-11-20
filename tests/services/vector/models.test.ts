import { describe, expect, it } from 'bun:test';
import { LocalEmbedder } from '../../../src/services/vector/LocalEmbedder.js';
import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_MODELS,
  resolveEmbeddingModel,
} from '../../../src/services/vector/models.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';

describe('embedding models', () => {
  it('resolves the default setting to the default model', () => {
    expect(resolveEmbeddingModel(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_EMBEDDING_MODEL))
      .toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it('rejects an unknown model by name, listing the known ones', () => {
    expect(() => resolveEmbeddingModel('multilingual')).toThrow(
      'CLAUDE_MEM_EMBEDDING_MODEL="multilingual" is not a known embedding model; use one of ' +
      'all-MiniLM-L6-v2, paraphrase-multilingual-MiniLM-L12-v2, multilingual-e5-small, ' +
      'granite-embedding-97m-multilingual-r2',
    );
  });

  it('gives each model its own identity, token limit included', () => {
    const ids = Object.values(EMBEDDING_MODELS).map(model => new LocalEmbedder(model).modelId);
    expect(ids).toEqual([
      'Xenova/all-MiniLM-L6-v2/fp32/mean/l2/256',
      'Xenova/paraphrase-multilingual-MiniLM-L12-v2/fp32/mean/l2/128',
      'Xenova/multilingual-e5-small/fp32/mean/l2/512',
      'onnx-community/granite-embedding-97m-multilingual-r2-ONNX/fp32/cls/l2/512',
    ]);
  });

  it('prefixes e5 queries and stored text differently, and nothing else', async () => {
    class Recording extends LocalEmbedder {
      seen: string[] = [];
      protected override async encode(texts: string[]): Promise<Float32Array[]> {
        this.seen.push(...texts);
        return texts.map(() => new Float32Array(this.dims));
      }
    }
    const e5 = new Recording(EMBEDDING_MODELS['multilingual-e5-small']);
    await e5.embed(['what changed'], 'query');
    await e5.embed(['the gateway moved']);
    expect(e5.seen).toEqual(['query: what changed', 'passage: the gateway moved']);

    const minilm = new Recording(DEFAULT_EMBEDDING_MODEL);
    await minilm.embed(['what changed'], 'query');
    expect(minilm.seen).toEqual(['what changed']);
  });
});
