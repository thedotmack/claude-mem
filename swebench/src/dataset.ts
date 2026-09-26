/**
 * SWE-bench dataset loading.
 *
 * Two sources are supported:
 *   - A local file (.jsonl one-object-per-line, or a .json array). This is the
 *     path used in restricted environments where huggingface.co is unreachable.
 *   - The Hugging Face datasets-server rows API, which returns dataset rows as
 *     plain JSON (no parquet parsing, no python). Used by `cmem-swebench fetch`.
 *
 * The default dataset is SWE-bench Verified (the 500 human-validated instances
 * that current leaderboard submissions report against).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { SweBenchInstance } from './types.ts';

export const DATASETS = {
  verified: 'princeton-nlp/SWE-bench_Verified',
  lite: 'princeton-nlp/SWE-bench_Lite',
  full: 'princeton-nlp/SWE-bench',
} as const;

export type DatasetKey = keyof typeof DATASETS;

/** Resolve a friendly key ("verified") or a raw HF dataset id to the HF id. */
export function resolveDatasetId(name: string): string {
  return (DATASETS as Record<string, string>)[name] ?? name;
}

/**
 * FAIL_TO_PASS / PASS_TO_PASS arrive as a JSON-encoded string in the raw
 * datasets and as arrays in some mirrors. Normalize to a string[] either way.
 */
export function normalizeTestList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Not JSON — treat as a single test id.
    }
    return [trimmed];
  }
  return [];
}

/** Parse a .jsonl (one object per line) or .json (array) file into instances. */
export function parseInstances(text: string): SweBenchInstance[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed[0] === '[') {
    const arr = JSON.parse(trimmed) as unknown[];
    return arr.map(asInstance);
  }
  const out: SweBenchInstance[] = [];
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    out.push(asInstance(JSON.parse(l)));
  }
  return out;
}

function asInstance(row: unknown): SweBenchInstance {
  if (!row || typeof row !== 'object') {
    throw new Error(`Dataset row is not an object: ${JSON.stringify(row)}`);
  }
  const r = row as Record<string, unknown>;
  if (typeof r.instance_id !== 'string') {
    throw new Error(`Dataset row missing instance_id: ${JSON.stringify(row).slice(0, 200)}`);
  }
  return r as SweBenchInstance;
}

export function loadInstancesFromFile(path: string): SweBenchInstance[] {
  return parseInstances(readFileSync(path, 'utf-8'));
}

export interface SelectOptions {
  /** Explicit instance ids (comma-separated on the CLI). Overrides count. */
  ids?: string[];
  /** Take at most N instances (after id filtering). */
  count?: number;
  /** Skip the first N instances before taking `count`. */
  offset?: number;
}

/** Deterministic filter+slice. No randomness — reproducible runs by default. */
export function selectInstances(instances: SweBenchInstance[], opts: SelectOptions = {}): SweBenchInstance[] {
  let out = instances;
  if (opts.ids && opts.ids.length > 0) {
    const wanted = new Set(opts.ids);
    out = out.filter((i) => wanted.has(i.instance_id));
  }
  if (opts.offset && opts.offset > 0) out = out.slice(opts.offset);
  if (opts.count !== undefined && opts.count >= 0) out = out.slice(0, opts.count);
  return out;
}

/** One page of the HF datasets-server rows API. */
interface RowsResponse {
  rows?: Array<{ row?: Record<string, unknown> }>;
  num_rows_total?: number;
}

/**
 * Download a split from the HF datasets-server rows API into memory. Paginates
 * in 100-row pages (the API maximum). Requires network access to
 * datasets-server.huggingface.co.
 */
export async function downloadDataset(opts: {
  dataset: string;
  split?: string;
  config?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (loaded: number, total: number | undefined) => void;
}): Promise<SweBenchInstance[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const dataset = resolveDatasetId(opts.dataset);
  const split = opts.split ?? 'test';
  const config = opts.config ?? 'default';
  const pageSize = 100;
  const out: SweBenchInstance[] = [];
  let offset = 0;
  let total: number | undefined;

  do {
    const url =
      `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}` +
      `&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}` +
      `&offset=${offset}&length=${pageSize}`;
    const res = await doFetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HF datasets-server error ${res.status} for ${dataset}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as RowsResponse;
    total = data.num_rows_total ?? total;
    const rows = data.rows ?? [];
    // An empty page always terminates. Otherwise we page until the known total
    // is reached; when the total is unknown, the next (empty) page ends it. We
    // deliberately do NOT stop on a short page — the HF API can return fewer
    // than `length` rows mid-dataset — so we rely on total/empty-page instead.
    if (rows.length === 0) break;
    for (const wrapper of rows) {
      if (wrapper.row) out.push(asInstance(wrapper.row));
    }
    offset += rows.length;
    opts.onProgress?.(out.length, total);
    if (total !== undefined && out.length >= total) break;
  } while (true);

  return out;
}

/** Serialize instances to a .jsonl file (round-trips through parseInstances). */
export function writeInstancesJsonl(path: string, instances: SweBenchInstance[]): void {
  writeFileSync(path, instances.map((i) => JSON.stringify(i)).join('\n') + '\n', 'utf-8');
}
