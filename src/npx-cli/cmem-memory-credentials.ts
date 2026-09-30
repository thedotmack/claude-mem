import { spawnSync } from 'node:child_process';
import net from 'node:net';
import type { SettingsDefaults } from '../shared/SettingsDefaultsManager.js';
import { isCmemGatewayUrl } from '../shared/cmem-gateway.js';
import { CMEM_PRO_BASE_URL, CMEM_PRO_MODEL } from './cmem-pro-costs.js';

export const HOST_OBSERVER_DEFAULT_PORT = '37777';
export const HOST_OBSERVER_DUMMY_API_KEY = 'host-observer-local';

export type HostObserverPortStatus = 'observer' | 'occupied' | 'free';

export type HostObserverPortProbe = (port: number) => HostObserverPortStatus;

export class HostObserverUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostObserverUnavailableError';
  }
}

export interface DeliveredCmemMemoryCredentials {
  memoryKey: string;
  memoryBaseUrl: string;
  memoryModel: string;
}

export interface ResolvedCmemMemoryCredentials extends DeliveredCmemMemoryCredentials {
  source: 'fresh' | 'staged' | 'configured';
  /** Fresh material may safely retry the gateway and reset the notice marker. */
  clearFallback: boolean;
}

type SettingsLike = Partial<Record<keyof SettingsDefaults, unknown>>;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsePort(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535) {
    return value;
  }
  const asString = nonEmptyString(value);
  if (!asString) return null;
  if (!/^\d+$/.test(asString)) return null;
  const parsed = Number(asString);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return null;
  return parsed;
}

function looksLikeOpenAICompatible(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as {
      object?: unknown;
      data?: unknown;
      choices?: unknown;
      error?: { message?: unknown; type?: unknown };
    };
    if (!parsed || typeof parsed !== 'object') return false;
    if (Array.isArray(parsed.choices)) return true;
    if (Array.isArray(parsed.data) && (parsed.object === 'list' || parsed.data.some((item) => item && typeof item === 'object'))) {
      return true;
    }
    if (parsed.error && typeof parsed.error === 'object') {
      return typeof parsed.error.message === 'string' || typeof parsed.error.type === 'string';
    }
    return false;
  } catch {
    return false;
  }
}

async function canBindLoopback(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    const finish = (available: boolean) => {
      server.removeAllListeners();
      try {
        server.close();
      } catch {
        // already closed
      }
      resolve(available);
    };
    server.once('error', () => finish(false));
    server.listen(port, '127.0.0.1', () => finish(true));
  });
}

async function fetchLoopback(path: string, port: number, init?: RequestInit): Promise<{ ok: boolean; status: number; body: string } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(400),
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } catch {
    return null;
  }
}

/**
 * Probe a loopback port for an already-running OpenAI-compatible observer.
 * Does not start a shim. Occupied non-observer listeners are never treated as available.
 */
export async function probeHostObserverPort(port: number): Promise<HostObserverPortStatus> {
  const headers = {
    Authorization: `Bearer ${HOST_OBSERVER_DUMMY_API_KEY}`,
    'Content-Type': 'application/json',
  };

  const models = await fetchLoopback('/v1/models', port, { headers });
  if (models && looksLikeOpenAICompatible(models.body)) return 'observer';

  const completions = await fetchLoopback('/v1/chat/completions', port, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'host-observer-probe',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    }),
  });
  if (completions && looksLikeOpenAICompatible(completions.body)) return 'observer';

  if (models || completions) return 'occupied';
  return (await canBindLoopback(port)) ? 'free' : 'occupied';
}

/** Synchronous install-time probe. Does not start a shim. */
export function probeHostObserverPortSync(port: number): HostObserverPortStatus {
  const auth = `Authorization: Bearer ${HOST_OBSERVER_DUMMY_API_KEY}`;
  const models = spawnSync('curl', ['-sS', '-m', '1', '-H', auth, `http://127.0.0.1:${port}/v1/models`], {
    encoding: 'utf8',
    timeout: 2000,
  });
  const modelsOut = (models.stdout ?? '').toString();
  if (models.status === 0 && looksLikeOpenAICompatible(modelsOut)) return 'observer';

  const completions = spawnSync('curl', [
    '-sS', '-m', '1', '-H', auth, '-H', 'Content-Type: application/json',
    '-d', '{"model":"host-observer-probe","messages":[{"role":"user","content":"ping"}],"max_tokens":1}',
    `http://127.0.0.1:${port}/v1/chat/completions`,
  ], { encoding: 'utf8', timeout: 2000 });
  const completionsOut = (completions.stdout ?? '').toString();
  if (completions.status === 0 && looksLikeOpenAICompatible(completionsOut)) return 'observer';

  if ((models.status === 0 && modelsOut) || (completions.status === 0 && completionsOut)) {
    return 'occupied';
  }

  const bind = spawnSync(process.execPath, ['-e', `
    const net = require('net');
    const server = net.createServer();
    server.once('error', () => process.exit(1));
    server.listen(${port}, '127.0.0.1', () => server.close(() => process.exit(0)));
  `], { timeout: 1500 });
  return bind.status === 0 ? 'free' : 'occupied';
}

export function hostObserverCandidatePorts(
  workerPort: string | number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number[] {
  const worker = parsePort(typeof workerPort === 'number' ? workerPort : nonEmptyString(workerPort));
  const configured = parsePort(env.CLAUDE_MEM_HOST_OBSERVER_PORT);
  if (configured != null) return [configured];

  const preferred = parsePort(HOST_OBSERVER_DEFAULT_PORT) ?? 37777;
  const fallback = preferred + 1;
  return [preferred, fallback].filter((port) => worker == null || port !== worker);
}

/**
 * Resolve the account-owned cmem gateway key without consulting environment
 * overrides (callers pass the raw settings document). Priority is deliberate:
 * this run's one-shot delivery, then staged delivery, then an already-active
 * cmem OpenRouter configuration from an earlier install.
 */
export function resolveCmemMemoryCredentials(
  delivered: DeliveredCmemMemoryCredentials | null,
  settings: SettingsLike,
): ResolvedCmemMemoryCredentials | null {
  if (delivered) {
    return {
      memoryKey: delivered.memoryKey,
      memoryBaseUrl: delivered.memoryBaseUrl,
      memoryModel: delivered.memoryModel,
      source: 'fresh',
      clearFallback: true,
    };
  }

  const stagedKey = nonEmptyString(settings.CLAUDE_MEM_PRO_MEMORY_KEY);
  if (stagedKey) {
    return {
      memoryKey: stagedKey,
      memoryBaseUrl: nonEmptyString(settings.CLAUDE_MEM_PRO_MEMORY_BASE_URL) ?? CMEM_PRO_BASE_URL,
      memoryModel: nonEmptyString(settings.CLAUDE_MEM_PRO_MEMORY_MODEL) ?? CMEM_PRO_MODEL,
      source: 'staged',
      // A staged key moved out of a failed configured slot retains the marker;
      // a newly delivered key clears it in completeCmemTrialPairing.
      clearFallback: !nonEmptyString(settings.CLAUDE_MEM_PRO_FALLBACK_AT),
    };
  }

  const configuredKey = nonEmptyString(settings.CLAUDE_MEM_OPENROUTER_API_KEY);
  const configuredBaseUrl = nonEmptyString(settings.CLAUDE_MEM_OPENROUTER_BASE_URL);
  if (configuredKey && configuredBaseUrl && isCmemGatewayUrl(configuredBaseUrl)) {
    return {
      memoryKey: configuredKey,
      memoryBaseUrl: configuredBaseUrl,
      memoryModel: nonEmptyString(settings.CLAUDE_MEM_OPENROUTER_MODEL) ?? CMEM_PRO_MODEL,
      source: 'configured',
      // Merely rerunning install is not evidence that a rejected key is funded
      // again. Keep fallback active until fresh material or a gateway probe.
      clearFallback: false,
    };
  }

  return null;
}

/** Atomically move staged/current credentials into the active provider slot. */

export function resolveHostObserverPort(
  workerPort: string | number | undefined,
  env: NodeJS.ProcessEnv = process.env,
  probe: HostObserverPortProbe = probeHostObserverPortSync,
): string {
  const worker = parsePort(typeof workerPort === 'number' ? workerPort : nonEmptyString(workerPort));
  const configuredRaw = nonEmptyString(env.CLAUDE_MEM_HOST_OBSERVER_PORT);
  if (configuredRaw) {
    const configured = parsePort(configuredRaw);
    if (configured == null) {
      throw new HostObserverUnavailableError(
        `CLAUDE_MEM_HOST_OBSERVER_PORT=${configuredRaw} is not a valid port. Set it to the port your OpenAI-compatible observer already listens on.`,
      );
    }
    if (worker != null && configured === worker) {
      throw new HostObserverUnavailableError(
        `CLAUDE_MEM_HOST_OBSERVER_PORT=${configured} is the claude-mem worker port. Point it at your OpenAI-compatible observer instead.`,
      );
    }
    const status = probe(configured);
    if (status === 'observer') return String(configured);
    if (status === 'occupied') {
      throw new HostObserverUnavailableError(
        `CLAUDE_MEM_HOST_OBSERVER_PORT=${configured} is occupied by a process that is not an OpenAI-compatible observer. Stop that process or point CLAUDE_MEM_HOST_OBSERVER_PORT at your observer.`,
      );
    }
    throw new HostObserverUnavailableError(
      `CLAUDE_MEM_HOST_OBSERVER_PORT=${configured} has nothing listening. Start your OpenAI-compatible observer on that port, then rerun with --provider host.`,
    );
  }

  const candidates = hostObserverCandidatePorts(workerPort, env);
  for (const port of candidates) {
    const status = probe(port);
    if (status === 'observer') return String(port);
  }

  throw new HostObserverUnavailableError(
    `No OpenAI-compatible host observer is listening on 127.0.0.1:${candidates.join(' or ') || HOST_OBSERVER_DEFAULT_PORT}. Host mode uses an observer you already run; claude-mem does not start one. Start your observer, then rerun with --provider host. If it uses another port, set CLAUDE_MEM_HOST_OBSERVER_PORT.`,
  );
}

export function buildHostObserverSettings(
  observerModel: 'cursor' | 'grok-bot',
  settings: SettingsLike,
  env: NodeJS.ProcessEnv = process.env,
  probe?: HostObserverPortProbe,
): Record<string, string> {
  const workerPort = parsePort(settings.CLAUDE_MEM_WORKER_PORT)
    ?? nonEmptyString(settings.CLAUDE_MEM_WORKER_PORT)
    ?? undefined;
  const port = resolveHostObserverPort(workerPort, env, probe ?? probeHostObserverPortSync);
  return {
    CLAUDE_MEM_PROVIDER: 'openrouter',
    CLAUDE_MEM_OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/v1`,
    CLAUDE_MEM_OPENROUTER_MODEL: observerModel,
    CLAUDE_MEM_OPENROUTER_API_KEY: HOST_OBSERVER_DUMMY_API_KEY,
  };
}

export function buildCmemActivationSettings(
  credentials: ResolvedCmemMemoryCredentials,
): Record<string, string> {
  return {
    CLAUDE_MEM_PROVIDER: 'openrouter',
    CLAUDE_MEM_OPENROUTER_BASE_URL: credentials.memoryBaseUrl,
    CLAUDE_MEM_OPENROUTER_MODEL: credentials.memoryModel,
    CLAUDE_MEM_OPENROUTER_API_KEY: credentials.memoryKey,
    CLAUDE_MEM_PRO_MEMORY_KEY: '',
    CLAUDE_MEM_PRO_MEMORY_BASE_URL: '',
    CLAUDE_MEM_PRO_MEMORY_MODEL: '',
    ...(credentials.clearFallback ? { CLAUDE_MEM_PRO_FALLBACK_AT: '' } : {}),
  };
}

/**
 * Make the Anthropic Max choice genuinely local, including on a reinstall
 * after CMEM Pro. Cloud credentials and staged CMEM material are removed. An
 * active CMEM gateway key is removed too, while unrelated personal OpenRouter
 * credentials are left untouched for a future explicit provider switch.
 */
export function buildAnthropicMaxLocalSettings(
  settings: SettingsLike,
): Record<string, string> {
  const activeBaseUrl = nonEmptyString(settings.CLAUDE_MEM_OPENROUTER_BASE_URL);
  const activeProviderIsCmem = Boolean(activeBaseUrl && isCmemGatewayUrl(activeBaseUrl));

  return {
    CLAUDE_MEM_PROVIDER: 'claude',
    CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription',
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: '',
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: '',
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: '',
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '',
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: '',
    CLAUDE_MEM_PRO_MEMORY_KEY: '',
    CLAUDE_MEM_PRO_MEMORY_BASE_URL: '',
    CLAUDE_MEM_PRO_MEMORY_MODEL: '',
    ...(activeProviderIsCmem
      ? {
          CLAUDE_MEM_OPENROUTER_API_KEY: '',
          CLAUDE_MEM_OPENROUTER_BASE_URL: '',
          CLAUDE_MEM_OPENROUTER_MODEL: '',
        }
      : {}),
  };
}

/**
 * Switch from the cmem gateway to a personal OpenRouter key without ever
 * combining that personal key with cmem's endpoint/model. If the active slot
 * contains the only cmem key, move it back to staging before replacing it.
 */
export function buildPersonalOpenRouterSettings(
  apiKey: string,
  settings: SettingsLike,
  defaultOpenRouterModel: string,
): Record<string, string> {
  let stagedKey = nonEmptyString(settings.CLAUDE_MEM_PRO_MEMORY_KEY) ?? '';
  let stagedBaseUrl = nonEmptyString(settings.CLAUDE_MEM_PRO_MEMORY_BASE_URL) ?? '';
  let stagedModel = nonEmptyString(settings.CLAUDE_MEM_PRO_MEMORY_MODEL) ?? '';

  const configuredKey = nonEmptyString(settings.CLAUDE_MEM_OPENROUTER_API_KEY);
  const configuredBaseUrl = nonEmptyString(settings.CLAUDE_MEM_OPENROUTER_BASE_URL);
  if (!stagedKey && configuredKey && configuredBaseUrl && isCmemGatewayUrl(configuredBaseUrl)) {
    stagedKey = configuredKey;
    stagedBaseUrl = configuredBaseUrl;
    stagedModel = nonEmptyString(settings.CLAUDE_MEM_OPENROUTER_MODEL) ?? CMEM_PRO_MODEL;
  }

  return {
    CLAUDE_MEM_PROVIDER: 'openrouter',
    CLAUDE_MEM_OPENROUTER_API_KEY: apiKey.trim(),
    CLAUDE_MEM_OPENROUTER_BASE_URL: '',
    CLAUDE_MEM_OPENROUTER_MODEL: defaultOpenRouterModel,
    CLAUDE_MEM_PRO_MEMORY_KEY: stagedKey,
    CLAUDE_MEM_PRO_MEMORY_BASE_URL: stagedBaseUrl,
    CLAUDE_MEM_PRO_MEMORY_MODEL: stagedModel,
  };
}

/**
 * Make `--provider openrouter` safe when a previous interactive install left
 * a cmem gateway configuration active. The flag cannot prompt for a personal
 * key, so move the cmem key back to staging and clear its endpoint/model from
 * the generic slot. A key supplied later through the environment will then use
 * OpenRouter's normal endpoint instead of being sent to cmem.ai.
 */
export function buildNonInteractiveOpenRouterSettings(
  settings: SettingsLike,
  defaultOpenRouterModel: string,
): Record<string, string> {
  const configuredBaseUrl = nonEmptyString(settings.CLAUDE_MEM_OPENROUTER_BASE_URL);
  if (!configuredBaseUrl || !isCmemGatewayUrl(configuredBaseUrl)) {
    return { CLAUDE_MEM_PROVIDER: 'openrouter' };
  }

  return buildPersonalOpenRouterSettings('', settings, defaultOpenRouterModel);
}
