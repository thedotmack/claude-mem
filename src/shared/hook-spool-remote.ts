import { z } from 'zod';
import type { HookSpoolEntry } from './hook-spool.js';
import { normalizePlatformSource } from './platform-source.js';
import { formatHostForUrl } from './worker-url.js';

export const REMOTE_SPOOL_PROTOCOL_VERSION = 1;
export const REMOTE_SPOOL_TIMEOUT_MS = 1000;
export const REMOTE_SPOOL_MAX_ENTRIES = 16;

const commonPayload = z.object({
  contentSessionId: z.string().min(1).max(512),
  platformSource: z.string().min(1).max(128),
  cwd: z.string().max(32768).optional(),
}).passthrough();
const observationPayload = commonPayload.extend({
  toolName: z.string().min(1).max(512),
  toolInput: z.unknown(),
  toolResponse: z.unknown(),
  toolUseId: z.string().max(2048).optional(),
  agentId: z.string().max(128).optional(),
  agentType: z.string().max(128).optional(),
});
const timestamp = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const entrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('observation'), payload: observationPayload, enqueuedAtEpochMs: timestamp }),
  z.object({ kind: z.literal('file_edit'), payload: observationPayload, enqueuedAtEpochMs: timestamp }),
  z.object({ kind: z.literal('summarize'), payload: commonPayload.extend({
    lastAssistantMessage: z.string(),
    observedModel: z.string().max(1024).optional(),
    observedBilling: z.string().max(1024).optional(),
  }), enqueuedAtEpochMs: timestamp }),
  z.object({ kind: z.literal('session_end'), payload: commonPayload, enqueuedAtEpochMs: timestamp }),
  z.object({ kind: z.literal('advisor_calls'), payload: commonPayload.extend({
    transcriptPath: z.string().max(32768).optional(),
    calls: z.array(z.object({
      toolUseId: z.string().min(1).max(2048),
      advice: z.string(),
      advisorModel: z.string().nullable().optional(),
      occurredAtEpoch: timestamp,
      lastUserMessage: z.string().nullable().optional(),
      transcriptByteOffset: z.number().int().nonnegative().nullable().optional(),
    }).passthrough()).min(1).max(128),
  }), enqueuedAtEpochMs: timestamp }),
]);

export const remoteSpoolEnvelopeSchema = z.object({
  protocolVersion: z.literal(REMOTE_SPOOL_PROTOCOL_VERSION),
  entry: entrySchema,
}).strict();

export function normalizeRemoteSpoolEntry(entry: HookSpoolEntry): HookSpoolEntry {
  return { ...entry, payload: { ...entry.payload,
    platformSource: normalizePlatformSource(entry.payload.platformSource) } } as HookSpoolEntry;
}

export function remoteHookSpoolToken(value: unknown): string {
  if (typeof value !== 'string') return '';
  const token = value.trim();
  return token.length <= 1024 && /^[\x20-\x7e]+$/.test(token) ? token : '';
}

export function usesRemoteHookSpool(host: string | undefined, transport: string = 'auto'): boolean {
  transport = transport.trim().toLowerCase();
  if (transport === 'http') return true;
  if (transport === 'filesystem') return false;
  if (!host) return false;
  let normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  try { normalized = new URL(`http://${formatHostForUrl(host)}`).hostname.replace(/^\[|\]$/g, ''); } catch {}
  return !(normalized === 'localhost' || normalized.endsWith('.localhost')
    || normalized === '0.0.0.0' || normalized === '::' || normalized === '::1'
    || /^127\.\d+\.\d+\.\d+$/.test(normalized)
    || /^::ffff:127\.\d+\.\d+\.\d+$/.test(normalized)
    || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(normalized));
}
