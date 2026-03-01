/**
 * Backfill enrichment script — extract topics, entities, event_date for existing observations.
 *
 * CLI usage:
 *   npx tsx src/scripts/backfill-enrichment.ts [--model <model>] [--concurrency <n>] [--limit <n>] [--dry-run]
 *
 * Environment variables:
 *   LITELLM_PROXY_URL — LiteLLM proxy URL (default: http://localhost:4000)
 *   LITELLM_PROXY_KEY — LiteLLM proxy API key (required)
 */

import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ObservationRow {
  id: number;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
}

interface ExtractionResult {
  topics: string[];
  entities: Array<{ name: string; type: string }>;
  event_date: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_ENTITY_TYPES = ['person', 'system', 'team', 'technology', 'component'] as const;

// ---------------------------------------------------------------------------
// Exported utilities (tested independently)
// ---------------------------------------------------------------------------

/**
 * Build the LLM prompt for extracting enrichment metadata from an observation.
 */
export function buildExtractionPrompt(obs: {
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
}): string {
  const parts: string[] = [];

  if (obs.title) parts.push(`Title: ${obs.title}`);
  if (obs.subtitle) parts.push(`Subtitle: ${obs.subtitle}`);
  if (obs.narrative) parts.push(`Narrative: ${obs.narrative}`);
  if (obs.facts && obs.facts !== '[]') parts.push(`Facts: ${obs.facts}`);
  if (obs.concepts && obs.concepts !== '[]') parts.push(`Concepts: ${obs.concepts}`);

  const content = parts.join('\n');

  return `Extract structured metadata from this software development observation.

OBSERVATION:
${content}

Return ONLY valid JSON (no markdown, no explanation) with this exact structure:
{
  "topics": ["2-5 semantic category tags like auth, deployment, database, testing, performance"],
  "entities": [{"name": "exact name", "type": "person|system|team|technology|component"}],
  "event_date": "YYYY-MM-DD or null if no specific date is mentioned"
}

Rules:
- topics: 2-5 lowercase kebab-case semantic categories (not the same as concepts)
- entities: people, systems, teams, technologies, or components mentioned by name
- event_date: only if a specific calendar date is referenced, otherwise null
- If unsure about entities, return empty array
- Return valid JSON only`;
}

/**
 * Parse the LLM's response text into a validated ExtractionResult.
 * Returns null if the response cannot be parsed.
 */
export function parseExtractionResponse(response: string): ExtractionResult | null {
  let text = response.trim();

  // Extract JSON from markdown code block if present
  const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(text);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;

    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.topics)) return null;

    return {
      topics: parsed.topics.filter((t: unknown) => typeof t === 'string') as string[],
      entities: Array.isArray(parsed.entities)
        ? validateEntityTypes(
            (parsed.entities as Array<Record<string, unknown>>).filter(
              (e) => typeof e === 'object' && e !== null && typeof e.name === 'string'
            ) as Array<{ name: string; type: string }>
          )
        : [],
      event_date: validateEventDate(
        typeof parsed.event_date === 'string' ? parsed.event_date : null
      ),
    };
  } catch {
    return null;
  }
}

/**
 * Validate entity types — invalid types fall back to "component".
 */
export function validateEntityTypes(
  entities: Array<{ name: string; type: string }>
): Array<{ name: string; type: string }> {
  return entities.map((e) => ({
    name: e.name,
    type: (VALID_ENTITY_TYPES as readonly string[]).includes(e.type) ? e.type : 'component',
  }));
}

/**
 * Validate event_date — must be ISO8601 YYYY-MM-DD format.
 */
export function validateEventDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return date;
}

/**
 * Get unenriched observations from the database.
 */
export function getUnenrichedObservations(
  db: Database.Database,
  limit?: number
): ObservationRow[] {
  const sql = limit !== undefined
    ? `SELECT id, title, subtitle, narrative, facts, concepts FROM observations WHERE topics IS NULL ORDER BY id ASC LIMIT ?`
    : `SELECT id, title, subtitle, narrative, facts, concepts FROM observations WHERE topics IS NULL ORDER BY id ASC`;
  const stmt = db.prepare(sql);
  return (limit !== undefined ? stmt.all(limit) : stmt.all()) as ObservationRow[];
}

/**
 * Update an observation with extracted enrichment data.
 * Applies empty-array-to-NULL coercion for backfill checkpoint compatibility.
 */
export function updateObservationEnrichment(
  db: Database.Database,
  id: number,
  data: ExtractionResult
): void {
  const topicsVal = data.topics.length > 0 ? JSON.stringify(data.topics) : null;
  const entitiesVal = data.entities.length > 0 ? JSON.stringify(data.entities) : null;
  const eventDateVal = data.event_date ?? null;

  db.prepare(`
    UPDATE observations
    SET topics = ?, entities = ?, event_date = ?
    WHERE id = ?
  `).run(topicsVal, entitiesVal, eventDateVal, id);
}

// ---------------------------------------------------------------------------
// CLI runner (only executes when run directly)
// ---------------------------------------------------------------------------

async function callLLM(
  prompt: string,
  model: string,
  proxyUrl: string,
  proxyKey: string
): Promise<string> {
  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${proxyKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content ?? '';
}

async function processObservation(
  db: Database.Database,
  obs: ObservationRow,
  model: string,
  fallbackModel: string,
  proxyUrl: string,
  proxyKey: string,
  dryRun: boolean
): Promise<'success' | 'fallback' | 'skipped'> {
  const prompt = buildExtractionPrompt(obs);

  // Try primary model
  try {
    const response = await callLLM(prompt, model, proxyUrl, proxyKey);
    const result = parseExtractionResponse(response);
    if (result) {
      if (!dryRun) {
        updateObservationEnrichment(db, obs.id, result);
      }
      return 'success';
    }
  } catch {
    // Fall through to fallback
  }

  // Try fallback model
  try {
    const response = await callLLM(prompt, fallbackModel, proxyUrl, proxyKey);
    const result = parseExtractionResponse(response);
    if (result) {
      if (!dryRun) {
        updateObservationEnrichment(db, obs.id, result);
      }
      return 'fallback';
    }
  } catch {
    // Fall through to skip
  }

  return 'skipped';
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag: string, defaultVal: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
  };

  const model = getArg('--model', 'cli-proxy/claude-haiku-4-5-latest');
  const fallbackModel = getArg('--fallback-model', 'zai/glm-4.5-air');
  const concurrency = parseInt(getArg('--concurrency', '5'), 10);
  const limit = args.includes('--limit') ? parseInt(getArg('--limit', '0'), 10) : undefined;
  const dryRun = args.includes('--dry-run');

  const proxyUrl = process.env.LITELLM_PROXY_URL ?? 'http://localhost:4000';
  const proxyKey = process.env.LITELLM_PROXY_KEY;

  if (!proxyKey) {
    console.error('Error: LITELLM_PROXY_KEY environment variable is required');
    process.exit(1);
  }

  const dbPath = `${process.env.HOME}/.magic-claude-mem/magic-claude-mem.db`;
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  console.log(`Backfill enrichment — model: ${model}, fallback: ${fallbackModel}, concurrency: ${concurrency}`);
  if (dryRun) console.log('DRY RUN — no database updates will be made');

  const observations = getUnenrichedObservations(db, limit);
  console.log(`Found ${observations.length} unenriched observations`);

  if (observations.length === 0) {
    console.log('Nothing to do. All observations are already enriched.');
    db.close();
    return;
  }

  let success = 0;
  let fallback = 0;
  let skipped = 0;
  let shutdownRequested = false;

  // Graceful shutdown on SIGINT
  process.on('SIGINT', () => {
    console.log('\nGraceful shutdown requested — finishing in-flight requests...');
    shutdownRequested = true;
  });

  // Process observations with concurrency limit
  const queue = [...observations];
  const workers: Promise<void>[] = [];

  for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
    workers.push(
      (async () => {
        while (queue.length > 0 && !shutdownRequested) {
          const obs = queue.shift()!;
          const result = await processObservation(
            db, obs, model, fallbackModel, proxyUrl, proxyKey, dryRun
          );
          if (result === 'success') success++;
          else if (result === 'fallback') fallback++;
          else skipped++;

          const total = success + fallback + skipped;
          if (total % 100 === 0) {
            console.log(`Progress: ${total}/${observations.length} (${success} success, ${fallback} fallback, ${skipped} skipped)`);
          }
        }
      })()
    );
  }

  await Promise.all(workers);

  console.log(`\nComplete: ${success + fallback + skipped}/${observations.length}`);
  console.log(`  Success: ${success}, Fallback: ${fallback}, Skipped: ${skipped}`);

  db.close();
}

// Only run main() when executed directly (not when imported for tests)
const isDirectRun = process.argv[1]?.endsWith('backfill-enrichment.ts') ||
                    process.argv[1]?.endsWith('backfill-enrichment.js');
if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
