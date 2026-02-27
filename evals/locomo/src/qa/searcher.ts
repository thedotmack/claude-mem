/**
 * Search retrieval module for the LoCoMo QA pipeline.
 *
 * Wraps the worker client's search API to retrieve observations relevant
 * to a given question, then formats them into a context string suitable
 * for prompting an LLM answerer.
 */

import {
  WorkerClient,
  type SearchObservationResult,
  type SearchResponse,
} from "../ingestion/worker-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchContextResult {
  formattedContext: string;
  observationsUsed: number;
  totalCharacters: number;
  searchLatencyMs: number;
  rawResults: SearchObservationResult[];
}

// ---------------------------------------------------------------------------
// Observation separator used for context windowing
// ---------------------------------------------------------------------------

const OBSERVATION_SEPARATOR = "\n---\n";

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search claude-mem observations for context relevant to a question.
 * Scoped to a conversation's project name.
 */
export async function searchForContext(
  question: string,
  project: string,
  limit: number,
  client?: WorkerClient
): Promise<SearchResponse> {
  const workerClient = client ?? new WorkerClient();
  return workerClient.search(question, project, limit);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format search result observations into a single context string.
 * Each observation includes its title, facts, and narrative with clear
 * section separators between observations.
 */
export function formatSearchResultsAsContext(
  observations: SearchObservationResult[]
): string {
  if (observations.length === 0) return "";

  const blocks = observations.map((obs) => {
    const parts: string[] = [];

    if (obs.title) {
      parts.push(`## ${obs.title}`);
    }
    if (obs.facts) {
      parts.push(`Facts: ${obs.facts}`);
    }
    if (obs.narrative) {
      parts.push(`Narrative: ${obs.narrative}`);
    }
    // Fall back to raw text if no structured fields
    if (parts.length === 0 && obs.text) {
      parts.push(obs.text);
    }

    return parts.join("\n");
  });

  return blocks.join(OBSERVATION_SEPARATOR);
}

// ---------------------------------------------------------------------------
// Context windowing
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHARS = 12000;

/**
 * Truncate context to fit within a character budget, cutting at the last
 * complete observation boundary rather than mid-sentence.
 *
 * Returns the truncated context plus metadata about what was kept.
 */
export function buildContextWindow(
  formattedContext: string,
  maxChars: number = DEFAULT_MAX_CHARS
): { context: string; observationsUsed: number; totalCharacters: number } {
  if (formattedContext.length <= maxChars) {
    const observationCount =
      formattedContext.length === 0
        ? 0
        : formattedContext.split(OBSERVATION_SEPARATOR).length;
    return {
      context: formattedContext,
      observationsUsed: observationCount,
      totalCharacters: formattedContext.length,
    };
  }

  const blocks = formattedContext.split(OBSERVATION_SEPARATOR);
  const keptBlocks: string[] = [];
  let currentLength = 0;

  for (const block of blocks) {
    const separatorCost =
      keptBlocks.length > 0 ? OBSERVATION_SEPARATOR.length : 0;
    const candidateLength = currentLength + separatorCost + block.length;

    if (candidateLength > maxChars) break;

    keptBlocks.push(block);
    currentLength = candidateLength;
  }

  const truncated = keptBlocks.join(OBSERVATION_SEPARATOR);
  return {
    context: truncated,
    observationsUsed: keptBlocks.length,
    totalCharacters: truncated.length,
  };
}
