import { ParsedObservation } from '../../sdk/parser.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

/** Each POST is bounded so a hung receiver can never hold anything up. */
export const BRAINBEAT_TIMEOUT_MS = 5000;

export interface GrokBotBrainbeatInput {
  observations: ParsedObservation[];
  observationIds: number[];
  project: string;
}

class BrainbeatHttpError extends Error {
  constructor(readonly status: number) {
    super(`Brainbeat webhook responded ${status}`);
    this.name = 'BrainbeatHttpError';
  }
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

/** Scheme, host and port only: the full URL can carry userinfo or query tokens. */
export function webhookOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    // [ANTI-PATTERN IGNORED]: an unparseable URL only affects what the log line
    // names; the POST itself fails and is logged by the caller.
    return '(invalid webhook URL)';
  }
}

/**
 * A log-safe reason for a failed POST. Never the error's message: fetch errors
 * can embed the full webhook URL, userinfo and query tokens included. Only the
 * HTTP status, a timeout, or the error's name plus a bare system code survive.
 */
export function brainbeatFailureReason(error: unknown): string {
  if (error instanceof BrainbeatHttpError) return `HTTP ${error.status}`;
  if (!(error instanceof Error)) return 'unknown error';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return `timed out after ${BRAINBEAT_TIMEOUT_MS}ms`;
  const code = (error as { code?: unknown }).code ?? (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code) ? `${error.name} (${code})` : error.name;
}

async function postBrainbeat(url: string, headers: Record<string, string>, body: string): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    // Never follow a redirect: it would carry the shared-secret header and the
    // observation to whatever origin the receiver names.
    redirect: 'error',
    signal: AbortSignal.timeout(BRAINBEAT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new BrainbeatHttpError(response.status);
  }
}

/**
 * Grok Bot "brainbeat": POST each observation that matches the Grok Bot
 * awareness triggers (CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES/CONCEPTS, the
 * same needles the awareness pusher delivers to seats as files) to
 * CLAUDE_MEM_GROK_BOT_WEBHOOK_URL. Off while that URL is empty, and independent
 * of every Telegram setting. Fire-and-forget: the POSTs run concurrently, each
 * bounded by BRAINBEAT_TIMEOUT_MS; redirects are refused; a failure is logged
 * with the receiver's origin and a log-safe reason only, and never thrown.
 */
export async function notifyGrokBotBrainbeat(input: GrokBotBrainbeatInput): Promise<void> {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const webhookUrl = (settings.CLAUDE_MEM_GROK_BOT_WEBHOOK_URL ?? '').trim();
  if (!webhookUrl) return;

  const triggerTypes = splitCsv(settings.CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES);
  const triggerConcepts = splitCsv(settings.CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_CONCEPTS);
  if (triggerTypes.length === 0 && triggerConcepts.length === 0) return;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const sharedSecret = (settings.CLAUDE_MEM_GROK_BOT_WEBHOOK_SECRET ?? '').trim();
  if (sharedSecret) headers['x-claude-mem-shared-secret'] = sharedSecret;

  const posts = input.observations.flatMap((observation, index) => {
    const matchedType = triggerTypes.includes(observation.type);
    const matchedConcepts = observation.concepts.filter(concept => triggerConcepts.includes(concept));
    if (!matchedType && matchedConcepts.length === 0) return [];

    const observationId = input.observationIds[index];
    const body = JSON.stringify({
      event: 'claude_mem.brainbeat',
      observation_id: observationId,
      type: observation.type,
      title: observation.title,
      subtitle: observation.subtitle,
      project: input.project,
      concepts: observation.concepts,
      why_fired: {
        matched_type: matchedType,
        matched_concepts: matchedConcepts,
      },
      timestamp: new Date().toISOString(),
    });
    return [postBrainbeat(webhookUrl, headers, body).catch((error: unknown) => {
      // No error object: its message and stack can hold the full webhook URL.
      logger.warn('AWARENESS', 'Grok Bot brainbeat webhook failed', {
        observationId,
        project: input.project,
        webhook: webhookOrigin(webhookUrl),
        reason: brainbeatFailureReason(error),
      });
    })];
  });

  await Promise.all(posts);
}
