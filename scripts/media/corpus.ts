import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MEDIA_LIMITS } from '../../src/shared/media-contract.js';
import type { EvaluationCorpus } from './evaluation.js';

export const CORPUS_DIRECTORY = new URL('../../tests/fixtures/media-v1/corpus/', import.meta.url);

/** Committed public fixtures are verified without importing the native decoder. */
export async function loadEvaluationCorpus(directory = CORPUS_DIRECTORY): Promise<EvaluationCorpus> {
  const bytes = await readFile(new URL('manifest.json', directory));
  if (bytes.byteLength > 256_000) throw new Error('evaluation manifest too large');
  const corpus = JSON.parse(bytes.toString('utf8')) as EvaluationCorpus;
  if (corpus.version !== 1 || corpus.origin !== 'public-generated-and-nasa' || !Array.isArray(corpus.fixtures) || corpus.fixtures.length !== 8) throw new Error('invalid public evaluation corpus');
  const ids = new Set<string>();
  for (const fixture of corpus.fixtures) {
    if (typeof fixture.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(fixture.id) || ids.has(fixture.id)) throw new Error('invalid fixture identity');
    ids.add(fixture.id);
    if (!Array.isArray(fixture.images) || fixture.images.length < 1 || fixture.images.length > MEDIA_LIMITS.maxImagesPerEvent || !Array.isArray(fixture.expected_observations) || !['screenshot-v1', 'photo-v1'].includes(fixture.recipe)) throw new Error('invalid fixture structure');
    const labels = new Set<string>();
    for (const image of fixture.images) {
      if (typeof image.file !== 'string' || !/^[a-z0-9-]+\.(?:png|jpg)$/.test(image.file) || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256)) throw new Error('invalid fixture source');
      if (typeof image.label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(image.label) || labels.has(image.label)) throw new Error('invalid fixture labels');
      labels.add(image.label);
      const asset = await readFile(new URL(image.file, directory));
      if (asset.byteLength > MEDIA_LIMITS.maxSourceBytes || createHash('sha256').update(asset).digest('hex') !== image.sha256) throw new Error('fixture checksum/bound mismatch');
      if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.width > MEDIA_LIMITS.maxDimension || image.height > MEDIA_LIMITS.maxDimension || image.width * image.height > MEDIA_LIMITS.maxPixels) throw new Error('invalid fixture dimensions');
    }
    for (const observation of fixture.expected_observations) {
      if (!Array.isArray(observation.image_labels) || observation.image_labels.length < 1 || observation.image_labels.some(label => !labels.has(label)) || !Array.isArray(observation.facts) || observation.facts.length < 1 || observation.facts.some(fact => typeof fact !== 'string' || fact.length > 4096)) throw new Error('invalid fixture grading data');
    }
  }
  return corpus;
}
