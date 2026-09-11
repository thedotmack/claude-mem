import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { ParsedObservation } from '../../sdk/parser.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { discoverGrokBotAgentDataRoot } from './GrokBotInstaller.js';

export const GROK_BOT_AWARENESS_PILOT_AGENT_IDS = [
  '521e962d-2ec3-4488-bfbc-54d5209ce118', // LFG
  '95601360-61f7-4fd9-bb3a-2c976b2b85c0', // Orifice
] as const;

const AGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINE_CHARS = 500;
const AWARENESS_TAG = '[awareness]';

export interface GrokBotAwarenessNotifyInput {
  observations: ParsedObservation[];
  observationIds: number[];
  project: string;
  memorySessionId: string;
  agentId?: string | null;
}

export interface GrokBotAwarenessPushConfig {
  enabled: boolean;
  agentIds: string[];
  triggerTypes: string[];
  triggerConcepts: string[];
  agentDataRoot: string;
  now?: Date;
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

export function loadGrokBotAwarenessConfig(
  settingsPath: string = USER_SETTINGS_PATH,
  env: NodeJS.ProcessEnv = process.env,
): GrokBotAwarenessPushConfig {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return {
    enabled: settings.CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED === 'true',
    agentIds: splitCsv(settings.CLAUDE_MEM_GROK_BOT_AWARENESS_AGENT_IDS),
    triggerTypes: splitCsv(settings.CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES),
    triggerConcepts: splitCsv(settings.CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_CONCEPTS),
    agentDataRoot: discoverGrokBotAgentDataRoot(env),
  };
}

export function observationMatchesAwarenessNeedle(
  obs: ParsedObservation,
  triggerTypes: string[],
  triggerConcepts: string[],
): boolean {
  if (triggerTypes.length === 0 && triggerConcepts.length === 0) {
    return false;
  }
  const matchesType = triggerTypes.includes(obs.type);
  const matchesConcept = obs.concepts.some(concept => triggerConcepts.includes(concept));
  return matchesType || matchesConcept;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function formatAwarenessLine(obs: ParsedObservation, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  const title = collapseWhitespace(obs.title ?? '');
  const subtitle = collapseWhitespace(obs.subtitle ?? '');
  const fact = collapseWhitespace(obs.facts[0] ?? '');
  const headline = [title, subtitle].filter(Boolean).join(': ');
  const detail = [headline, fact].filter(Boolean).join('. ');
  const body = collapseWhitespace(`${obs.type}${detail ? ` — ${detail}` : ''}`);
  const line = `- ${date} ${AWARENESS_TAG} ${body}`.trimEnd();
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS - 1)}…`;
}

export function awarenessLineBody(line: string): string {
  const idx = line.indexOf(AWARENESS_TAG);
  return idx >= 0 ? line.slice(idx).trim() : line.trim();
}

export function grokBotAwarenessLogPath(agentDataRoot: string, agentId: string, now: Date = new Date()): string {
  const yearMonth = now.toISOString().slice(0, 7);
  return path.join(agentDataRoot, 'agents', agentId, 'memory', 'log', `${yearMonth}.md`);
}

function assertSafeAwarenessLogPath(agentDataRoot: string, agentId: string, logPath: string): void {
  const expectedRoot = path.resolve(path.join(agentDataRoot, 'agents', agentId, 'memory', 'log'));
  const resolved = path.resolve(logPath);
  if (!resolved.startsWith(expectedRoot + path.sep) && resolved !== expectedRoot) {
    throw new Error('Refusing awareness write outside agent memory/log');
  }
  if (path.basename(resolved) === 'profile.md') {
    throw new Error('Refusing awareness write to profile.md');
  }
}

export function appendAwarenessLineAtomic(logPath: string, line: string): boolean {
  const dir = path.dirname(logPath);
  mkdirSync(dir, { recursive: true });

  const existing = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const incomingBody = awarenessLineBody(line);
  const alreadyPresent = existing
    .split('\n')
    .some(existingLine => existingLine.trim() && awarenessLineBody(existingLine) === incomingBody);
  if (alreadyPresent) {
    return false;
  }

  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  const next = `${prefix}${line}\n`;
  const tmpPath = `${logPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, next, 'utf8');
    renameSync(tmpPath, logPath);
  } catch (error) {
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup */ }
    throw error;
  }
  return true;
}

function resolvePilotAgentId(agentId: string | null | undefined, allowlist: string[]): string | null {
  if (typeof agentId !== 'string') return null;
  const trimmed = agentId.trim();
  if (!trimmed || !AGENT_ID_RE.test(trimmed)) return null;
  if (allowlist.length === 0) return null;
  return allowlist.includes(trimmed) ? trimmed : null;
}

export async function notifyGrokBotAwareness(
  input: GrokBotAwarenessNotifyInput,
  config: GrokBotAwarenessPushConfig = loadGrokBotAwarenessConfig(),
): Promise<void> {
  try {
    if (!config.enabled) return;

    const agentId = resolvePilotAgentId(input.agentId, config.agentIds);
    if (!agentId) return;

    if (config.triggerTypes.length === 0 && config.triggerConcepts.length === 0) {
      return;
    }

    const now = config.now ?? new Date();
    const logPath = grokBotAwarenessLogPath(config.agentDataRoot, agentId, now);
    assertSafeAwarenessLogPath(config.agentDataRoot, agentId, logPath);

    const { observations, observationIds, project, memorySessionId } = input;
    for (let i = 0; i < observations.length; i++) {
      const obs = observations[i];
      if (!observationMatchesAwarenessNeedle(obs, config.triggerTypes, config.triggerConcepts)) {
        continue;
      }

      try {
        const line = formatAwarenessLine(obs, now);
        const written = appendAwarenessLineAtomic(logPath, line);
        if (written) {
          logger.debug('AWARENESS', 'Appended Grok Bot awareness fact', {
            agentId,
            project,
            memorySessionId,
            observationId: observationIds[i],
            type: obs.type,
          });
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('AWARENESS', 'Failed to append Grok Bot awareness fact', {
          agentId,
          project,
          memorySessionId,
          observationId: observationIds[i],
          type: obs.type,
        }, err);
      }
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('AWARENESS', 'Grok Bot awareness push skipped', {
      project: input.project,
      memorySessionId: input.memorySessionId,
      agentId: input.agentId ?? undefined,
    }, err);
  }
}
