import * as p from '@clack/prompts';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

const SYNC_TOKEN_PATTERN = /^cm_pro_[0-9a-f]{32}$/;
const WORKER_KEY_PATTERN = /^cmem_worker_[A-Za-z0-9_-]{43}$/;
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CloudConnectionSettings {
  userId: string;
  hubUrl: string;
  syncToken: string;
  workerUrl?: string;
  workerKey?: string;
}

interface PublicCloudConnectionSettings {
  userId: string;
  hubUrl: string;
  workerUrl?: string;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedHttpsUrl(value: string, expectedPath?: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Connection URLs must be valid absolute URLs');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error('Connection URLs must use https and cannot contain credentials, query parameters, or fragments');
  }
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (expectedPath && pathname !== expectedPath) {
    throw new Error(`Managed Worker URL must end at ${expectedPath}`);
  }
  url.pathname = pathname;
  return url.toString().replace(/\/$/, '');
}

function validatePublicCloudConnection(
  input: PublicCloudConnectionSettings
): PublicCloudConnectionSettings {
  const userId = input.userId.trim();
  if (!USER_ID_PATTERN.test(userId)) throw new Error('Invalid CMEM user id');
  return {
    userId,
    hubUrl: normalizedHttpsUrl(input.hubUrl),
    ...(input.workerUrl
      ? { workerUrl: normalizedHttpsUrl(input.workerUrl, '/api/worker/v1') }
      : {}),
  };
}

export function validateCloudConnection(input: CloudConnectionSettings): CloudConnectionSettings {
  const publicConnection = validatePublicCloudConnection(input);
  if (!SYNC_TOKEN_PATTERN.test(input.syncToken)) throw new Error('Invalid CMEM sync token');

  const hasWorkerUrl = Boolean(input.workerUrl);
  const hasWorkerKey = Boolean(input.workerKey);
  if (hasWorkerUrl !== hasWorkerKey) {
    throw new Error('Managed Worker URL and key must be configured together');
  }
  if (input.workerKey && !WORKER_KEY_PATTERN.test(input.workerKey)) {
    throw new Error('Invalid CMEM worker key');
  }

  return {
    ...publicConnection,
    syncToken: input.syncToken,
    ...(input.workerUrl && input.workerKey
      ? {
          workerKey: input.workerKey,
        }
      : {}),
  };
}

/** Persist credentials without ever including them in argv or terminal output. */
export function saveCloudConnection(
  input: CloudConnectionSettings,
  settingsPath: string = USER_SETTINGS_PATH
): void {
  const connection = validateCloudConnection(input);
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const parsed = parseJsonWithBom(readFileSync(settingsPath, 'utf-8'));
    if (!plainObject(parsed)) throw new Error('Existing claude-mem settings must be a JSON object');
    settings = parsed;
  }

  const target = plainObject(settings.env) ? settings.env : settings;
  target.CLAUDE_MEM_CLOUD_SYNC_TOKEN = connection.syncToken;
  target.CLAUDE_MEM_CLOUD_SYNC_USER_ID = connection.userId;
  target.CLAUDE_MEM_CLOUD_SYNC_HUB_URL = connection.hubUrl;

  if (connection.workerUrl && connection.workerKey) {
    target.CLAUDE_MEM_PROVIDER = 'openrouter';
    target.CLAUDE_MEM_OPENROUTER_API_KEY = connection.workerKey;
    target.CLAUDE_MEM_OPENROUTER_BASE_URL = connection.workerUrl;
    target.CLAUDE_MEM_OPENROUTER_MODEL = 'cmem-managed';
    target.CLAUDE_MEM_OPENROUTER_SITE_URL = 'https://cmem.ai';
    target.CLAUDE_MEM_OPENROUTER_APP_NAME = 'CMEM Managed Worker';
  }

  writeJsonFileAtomic(settingsPath, settings, { mode: 0o600 });
}

function requiredString(value: string | boolean | undefined, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

async function secretPrompt(message: string, pattern: RegExp, error: string): Promise<string | null> {
  const result = await p.password({
    message,
    mask: '*',
    validate: (value) => pattern.test(value ?? '') ? undefined : error,
  });
  if (p.isCancel(result)) return null;
  return result;
}

export async function runCloudCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0]?.toLowerCase();
  if (subcommand !== 'connect') {
    throw new Error('Usage: npx claude-mem cloud connect --user-id <id> --hub-url <url> [--worker-url <url>]');
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      'user-id': { type: 'string' },
      'hub-url': { type: 'string' },
      'worker-url': { type: 'string' },
    },
    strict: true,
  });
  const userId = requiredString(values['user-id'], '--user-id');
  const hubUrl = requiredString(values['hub-url'], '--hub-url');
  const workerUrl = values['worker-url'] !== undefined
    ? requiredString(values['worker-url'], '--worker-url')
    : undefined;

  // Validate public values before asking the user for any secret.
  validatePublicCloudConnection({
    userId,
    hubUrl,
    workerUrl,
  });

  p.intro('Connect claude-mem to CMEM Cloud');
  const syncToken = await secretPrompt(
    'Paste the CMEM sync token (input is hidden)',
    SYNC_TOKEN_PATTERN,
    'Enter the cm_pro_… sync token from cmem.ai → Connect'
  );
  if (!syncToken) {
    p.cancel('Connection cancelled; no settings were changed.');
    return;
  }

  let workerKey: string | undefined;
  if (workerUrl) {
    const result = await secretPrompt(
      'Paste the CMEM worker key (input is hidden)',
      WORKER_KEY_PATTERN,
      'Enter the cmem_worker_… key from cmem.ai → Connect'
    );
    if (!result) {
      p.cancel('Connection cancelled; no settings were changed.');
      return;
    }
    workerKey = result;
  }

  saveCloudConnection({ userId, hubUrl, syncToken, workerUrl, workerKey });
  p.outro(
    workerUrl
      ? 'CMEM Cloud and Managed Worker saved securely. Restart claude-mem to apply them.'
      : 'CMEM Cloud saved securely. Restart claude-mem to apply it.'
  );
}
