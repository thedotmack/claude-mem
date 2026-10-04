/**
 * mem-search tools exposed to the solving agent.
 *
 * These are the same three primitives the claude-mem MCP server exposes
 * (`search` → GET /api/search, `timeline` → GET /api/timeline,
 * `get_observations` → POST /api/observations/batch), re-issued directly
 * against the local claude-mem worker. Wiring them as agent tools is the whole
 * point of this harness: the model can recall how similar issues were solved in
 * prior sessions before writing a patch.
 *
 * Tools are namespaced `mem_*` so they don't collide with the agent's own
 * bash/apply tools, and follow the documented 3-layer workflow
 * (search → timeline → get_observations) for token efficiency.
 */
import type { ToolDefinition } from './types.ts';
import type { WorkerConfig } from './config.ts';

export const MEM_TOOL_NAMES = ['mem_search', 'mem_timeline', 'mem_get_observations'] as const;
export type MemToolName = (typeof MEM_TOOL_NAMES)[number];

export function isMemTool(name: string): name is MemToolName {
  return (MEM_TOOL_NAMES as readonly string[]).includes(name);
}

/** Thin HTTP client over the claude-mem worker's search surface. */
export class MemSearchClient {
  constructor(
    private readonly config: WorkerConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  /** True if the worker answers on its search endpoint. */
  async isReachable(): Promise<boolean> {
    try {
      const res = await this.get('/api/search', { query: '__healthcheck__', limit: 1 });
      return res.ok;
    } catch {
      return false;
    }
  }

  private withTimeout(): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    return { signal: controller.signal, done: () => clearTimeout(timer) };
  }

  private scoped(extra: Record<string, unknown>): Record<string, unknown> {
    // Fold the run-wide project/platform scope into every call unless the model
    // already specified them explicitly.
    return {
      ...(this.config.project ? { project: this.config.project } : {}),
      ...(this.config.platformSource ? { platformSource: this.config.platformSource } : {}),
      ...extra,
    };
  }

  private async get(path: string, params: Record<string, unknown>): Promise<Response> {
    const url = new URL(path, this.config.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
    }
    const { signal, done } = this.withTimeout();
    try {
      return await this.fetchImpl(url.toString(), { signal });
    } finally {
      done();
    }
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const url = new URL(path, this.config.baseUrl);
    const { signal, done } = this.withTimeout();
    try {
      return await this.fetchImpl(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } finally {
      done();
    }
  }

  async search(args: Record<string, unknown>): Promise<string> {
    const res = await this.get('/api/search', this.scoped(args));
    return bodyToText(res);
  }

  async timeline(args: Record<string, unknown>): Promise<string> {
    const res = await this.get('/api/timeline', this.scoped(args));
    return bodyToText(res);
  }

  async getObservations(args: Record<string, unknown>): Promise<string> {
    const ids = normalizeIds(args.ids);
    if (ids.length === 0) return 'Error: mem_get_observations requires a non-empty "ids" array of observation IDs.';
    const body = {
      ids,
      ...(this.config.project ? { project: this.config.project } : {}),
      ...(args.orderBy ? { orderBy: args.orderBy } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    };
    const res = await this.post('/api/observations/batch', body);
    return bodyToText(res);
  }
}

function normalizeIds(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map((x) => Number(x)).filter((n) => Number.isFinite(n));
  if (typeof raw === 'number' && Number.isFinite(raw)) return [raw];
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => Number(s.trim().replace(/^#/, '')))
      .filter((n) => Number.isFinite(n));
  }
  return [];
}

async function bodyToText(res: Response): Promise<string> {
  const text = await res.text();
  if (!res.ok) return `mem-search worker error (${res.status}): ${text.slice(0, 500)}`;
  // Worker returns either MCP-style {content:[{text}]} or a raw JSON payload.
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { content?: unknown }).content)) {
      const content = (parsed as { content: Array<{ text?: string }> }).content;
      const joined = content.map((c) => c.text ?? '').join('\n').trim();
      if (joined) return joined;
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

/** Dispatch a mem-tool call by name. Returns the text to feed back to the model. */
export async function dispatchMemTool(name: MemToolName, args: Record<string, unknown>, client: MemSearchClient): Promise<string> {
  switch (name) {
    case 'mem_search':
      return client.search(args);
    case 'mem_timeline':
      return client.timeline(args);
    case 'mem_get_observations':
      return client.getObservations(args);
  }
}

/** OpenAI-schema tool definitions for the three mem-search primitives. */
export function memSearchToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'mem_search',
        description:
          'STEP 1 of claude-mem memory recall. Search past work across all prior sessions and return a compact index of matching observations (IDs, titles, dates). Call this FIRST, before writing any code, to check whether this repo/issue area was touched before. ~50-100 tokens/result.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search terms — symbols, filenames, error text, or a short description of the bug.' },
            limit: { type: 'number', description: 'Max results (default 20, max 100).' },
            type: { type: 'string', description: 'Optional: "observations", "sessions", or "prompts".' },
            obs_type: { type: 'string', description: 'Optional comma list: bugfix, feature, decision, discovery, change.' },
            orderBy: { type: 'string', description: '"date_desc" (default), "date_asc", or "relevance".' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mem_timeline',
        description:
          'STEP 2 of claude-mem memory recall. Get the chronological context around an interesting observation (what happened just before/after it). Pass an anchor ID from mem_search, or a query to auto-locate the anchor.',
        parameters: {
          type: 'object',
          properties: {
            anchor: { type: 'number', description: 'Observation ID to center on (from mem_search).' },
            query: { type: 'string', description: 'Alternatively, find the anchor automatically from this query.' },
            depth_before: { type: 'number', description: 'Items before the anchor (default 3, max 20).' },
            depth_after: { type: 'number', description: 'Items after the anchor (default 3, max 20).' },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mem_get_observations',
        description:
          'STEP 3 of claude-mem memory recall. Fetch the FULL narrative, facts, and touched files for specific observation IDs you selected from mem_search/mem_timeline. Batch all IDs into one call. ~500-1000 tokens/result — only fetch IDs that look genuinely relevant.',
        parameters: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'number' }, description: 'Observation IDs to fetch (required).' },
            orderBy: { type: 'string', description: '"date_desc" (default) or "date_asc".' },
            limit: { type: 'number', description: 'Optional cap on returned observations.' },
          },
          required: ['ids'],
          additionalProperties: false,
        },
      },
    },
  ];
}
