/**
 * `claude-mem delete` command
 *
 * Deletes observations by ID, date range, or search query.
 * Calls the worker's POST /api/observations/delete endpoint.
 *
 * Usage:
 *   claude-mem delete 123 456 789
 *   claude-mem delete --before 2026-01-01
 *   claude-mem delete --query "wrong pattern" [--dry-run] [--force]
 */

import { buildWorkerUrl, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';

interface DeleteResult {
  success: boolean;
  deleted: number[];
  notFound: number[];
}

interface SearchResult {
  observations?: Array<{ id: number; title?: string; created_at?: string }>;
}

/** POST /api/observations/delete and return the result. */
async function callDelete(ids: number[]): Promise<DeleteResult> {
  const response = await workerHttpRequest('/api/observations/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
    timeoutMs: 15_000,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Worker returned ${response.status}: ${text}`);
  }

  return response.json() as Promise<DeleteResult>;
}

/** Resolve IDs from --before <date> using the observations list endpoint. */
async function resolveIdsByDate(before: string): Promise<number[]> {
  const epoch = new Date(before).getTime();
  if (isNaN(epoch)) throw new Error(`Invalid date: ${before}`);

  // Fetch all observations (up to 1000) and filter by date
  const url = buildWorkerUrl(`/api/observations?limit=1000&offset=0`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to list observations: ${response.status}`);

  const data = await response.json() as { items?: Array<{ id: number; created_at_epoch: number }> };
  return (data.items ?? [])
    .filter(obs => obs.created_at_epoch < epoch)
    .map(obs => obs.id);
}

/** Resolve IDs from --query <term> using the search endpoint. */
async function resolveIdsByQuery(query: string): Promise<number[]> {
  const url = buildWorkerUrl(`/api/search?q=${encodeURIComponent(query)}&limit=100`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Search failed: ${response.status}`);

  const data = await response.json() as SearchResult;
  return (data.observations ?? []).map(obs => obs.id);
}

/** Read a line from stdin (for confirmation prompt). */
async function readLine(): Promise<string> {
  return new Promise(resolve => {
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', chunk => resolve((chunk as string).trim()));
    process.stdin.resume();
  });
}

/**
 * Main entry point for `claude-mem delete`.
 * @returns Process exit code (0 = success, 1 = error)
 */
export async function deleteCommand(argv: string[]): Promise<number> {
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const beforeIdx = argv.indexOf('--before');
  const queryIdx = argv.indexOf('--query');

  // Positional args are numeric IDs (filter out flags)
  const positionalIds = argv
    .filter(a => !a.startsWith('--'))
    .map(Number)
    .filter(n => Number.isInteger(n) && n > 0);

  let ids: number[];

  try {
    if (beforeIdx !== -1) {
      const date = argv[beforeIdx + 1];
      if (!date || date.startsWith('--')) {
        console.error('Error: --before requires a date argument (e.g. --before 2026-01-01)');
        return 1;
      }
      ids = await resolveIdsByDate(date);
    } else if (queryIdx !== -1) {
      const query = argv[queryIdx + 1];
      if (!query || query.startsWith('--')) {
        console.error('Error: --query requires a search term');
        return 1;
      }
      ids = await resolveIdsByQuery(query);
    } else if (positionalIds.length > 0) {
      ids = positionalIds;
    } else {
      console.error('Usage: claude-mem delete <id>...');
      console.error('       claude-mem delete --before <date>');
      console.error('       claude-mem delete --query <term> [--dry-run] [--force]');
      return 1;
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (ids.length === 0) {
    console.log('No observations matched.');
    return 0;
  }

  if (dryRun) {
    console.log(`Would delete ${ids.length} observation(s): ${ids.join(', ')}`);
    return 0;
  }

  if (!force) {
    process.stdout.write(`Delete ${ids.length} observation(s)? [y/N] `);
    const answer = await readLine();
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted.');
      return 0;
    }
  }

  try {
    const result = await callDelete(ids);

    if (result.deleted.length > 0) {
      console.log(`Deleted ${result.deleted.length} observation(s): ${result.deleted.join(', ')}`);
    }
    if (result.notFound.length > 0) {
      console.log(`Not found: ${result.notFound.join(', ')}`);
    }
    return 0;
  } catch (err) {
    logger.error('DELETE', 'Failed to delete observations', {}, err instanceof Error ? err : undefined);
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
