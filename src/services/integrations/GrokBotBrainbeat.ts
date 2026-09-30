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

async function postBrainbeat(url: string, headers: Record<string, string>, body: string): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(BRAINBEAT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Brainbeat webhook responded ${response.status}`);
  }
}

/**
 * Grok Bot "brainbeat": POST each observation that matches the Grok Bot
 * awareness triggers (CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES/CONCEPTS, the
 * same needles the awareness pusher delivers to seats as files) to
 * CLAUDE_MEM_GROK_BOT_WEBHOOK_URL. Off while that URL is empty, and independent
 * of every Telegram setting. Fire-and-forget: the POSTs run concurrently, each
 * bounded by BRAINBEAT_TIMEOUT_MS; a failure is logged with the receiver's
 * origin only and never thrown.
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
      logger.warn('AWARENESS', 'Grok Bot brainbeat webhook failed', {
        observationId,
        project: input.project,
        webhook: webhookOrigin(webhookUrl),
      }, error instanceof Error ? error : new Error(String(error)));
    })];
  });

  await Promise.all(posts);
}
