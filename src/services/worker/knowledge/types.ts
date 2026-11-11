
export interface CorpusFilter {
  project?: string;
  types?: string[];
  concepts?: string[];
  files?: string[];
  query?: string;
  date_start?: string;  
  date_end?: string;    
  limit?: number;
}

export interface CorpusStats {
  observation_count: number;
  token_estimate: number;
  date_range: { earliest: string; latest: string };
  type_breakdown: Record<string, number>;
}

export interface CorpusObservation {
  id: number;
  type: string;
  title: string;
  subtitle: string | null;
  narrative: string | null;
  facts: string[];
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  project: string;
  created_at: string;
  created_at_epoch: number;
}

export interface CorpusFile {
  version: 1;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  filter: CorpusFilter;
  stats: CorpusStats;
  system_prompt: string;
  session_id: string | null;
  observations: CorpusObservation[];
}

export interface QueryResult {
  answer: string;
  session_id: string;
  /**
   * Set by the API corpus agent, which sends an excerpt of the corpus rather
   * than the corpus: how many observations went to the model, and how many
   * matched the question. `sent < matching` means the answer saw a partial
   * excerpt. When nothing matches, the excerpt is the most recent
   * observations instead, `matching` is 0, and `observations_in_corpus` says
   * how many the corpus holds, so `sent < in_corpus` is the partial case then.
   * Absent on the Agent SDK path, which holds the whole corpus.
   */
  observations_sent?: number;
  observations_matching?: number;
  observations_in_corpus?: number;
  /**
   * How many of the observations sent had their text cut to fit the budget
   * (an observation that alone exceeds it). Set with the two counts above.
   */
  observations_truncated?: number;
}

/**
 * Per-call options for a corpus agent. `abortController` reaches the caller's
 * abort signal: the Agent SDK's `Options.abortController` on the Claude path,
 * the request signal on the API path.
 *
 * It lives here, not in `KnowledgeAgent.ts`, because the module that talks to
 * the Anthropic Agent SDK must not be reachable from the code that picks the
 * corpus agent — an API-provider install never loads that module at all.
 */
export interface KnowledgeAgentCallOptions {
  abortController?: AbortController;
}
