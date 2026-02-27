/**
 * Search retrieval module for the LoCoMo QA pipeline.
 *
 * Wraps the worker client's search API to retrieve observations relevant
 * to a given question, then formats them into a context string suitable
 * for prompting an LLM answerer.
 *
 * Includes a keyword-based fallback for when Chroma vector search is
 * unavailable (e.g., observations inserted directly into SQLite without
 * Chroma sync).
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
// Keyword search scoring
// ---------------------------------------------------------------------------

/**
 * Extract search terms from a question, filtering out common stop words.
 */
function extractSearchTerms(question: string): string[] {
  const stopWords = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "can", "could", "must", "about", "above",
    "after", "again", "against", "all", "am", "and", "any", "as", "at",
    "because", "before", "between", "both", "but", "by", "for", "from",
    "further", "get", "got", "here", "how", "if", "in", "into", "it",
    "its", "just", "me", "more", "most", "my", "no", "nor", "not", "of",
    "off", "on", "once", "only", "or", "other", "our", "out", "over",
    "own", "same", "she", "he", "so", "some", "such", "than", "that",
    "their", "them", "then", "there", "these", "they", "this", "those",
    "through", "to", "too", "under", "until", "up", "very", "we", "what",
    "when", "where", "which", "while", "who", "whom", "why", "with",
    "you", "your",
  ]);

  return question
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w));
}

/**
 * Score an observation against search terms using term frequency overlap.
 * Returns a score >= 0 (higher = more relevant).
 */
function scoreObservation(
  obs: SearchObservationResult,
  searchTerms: string[],
): number {
  if (searchTerms.length === 0) return 0;

  const searchableText = [
    obs.title ?? "",
    obs.subtitle ?? "",
    obs.narrative ?? "",
    obs.text ?? "",
    obs.facts ?? "",
  ]
    .join(" ")
    .toLowerCase();

  let matchedTerms = 0;
  let totalHits = 0;

  for (const term of searchTerms) {
    const regex = new RegExp(term, "gi");
    const matches = searchableText.match(regex);
    if (matches) {
      matchedTerms++;
      totalHits += matches.length;
    }
  }

  // Score: proportion of terms matched + small bonus for multiple hits
  const termCoverage = matchedTerms / searchTerms.length;
  const hitBonus = Math.min(totalHits / 20, 0.5); // cap bonus at 0.5
  return termCoverage + hitBonus;
}

/**
 * Rank observations by keyword relevance and return the top N.
 */
function rankByKeywords(
  observations: SearchObservationResult[],
  question: string,
  limit: number,
): SearchObservationResult[] {
  const searchTerms = extractSearchTerms(question);

  const scored = observations.map((obs) => ({
    obs,
    score: scoreObservation(obs, searchTerms),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored
    .filter((s) => s.score > 0)
    .slice(0, limit)
    .map((s) => ({ ...s.obs, score: s.score }));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Cache of all observations per project to avoid repeated API calls. */
const observationCache = new Map<string, SearchObservationResult[]>();

/**
 * Search claude-mem observations for context relevant to a question.
 * Scoped to a conversation's project name.
 *
 * Tries the Chroma-based vector search first. If no results are returned
 * (e.g., observations not synced to Chroma), falls back to keyword-based
 * search over all observations in the project.
 */
export async function searchForContext(
  question: string,
  project: string,
  limit: number,
  client?: WorkerClient
): Promise<SearchResponse> {
  const workerClient = client ?? new WorkerClient();
  const startMs = Date.now();

  // Try Chroma-based search first
  const chromaResult = await workerClient.search(question, project, limit);
  if (chromaResult.observations.length > 0) {
    return chromaResult;
  }

  // Fallback: keyword-based search over all project observations
  if (!observationCache.has(project)) {
    const { observations } = await workerClient.listObservationsByProject(project);
    observationCache.set(project, observations);
  }

  const allObs = observationCache.get(project)!;
  const ranked = rankByKeywords(allObs, question, limit);
  const searchLatencyMs = Date.now() - startMs;

  return {
    observations: ranked,
    sessions: [],
    prompts: [],
    totalResults: ranked.length,
    query: question,
    search_latency_ms: searchLatencyMs,
  };
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
