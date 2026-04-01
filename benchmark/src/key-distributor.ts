import { readFile } from 'node:fs/promises';

export class KeyFileNotFoundError extends Error {
  constructor(public readonly filePath: string) {
    super(`Keys env file not found: ${filePath}`);
    this.name = 'KeyFileNotFoundError';
  }
}

export class InvalidKeyError extends Error {
  constructor(
    public readonly keyName: string,
    public readonly reason: string,
  ) {
    super(`Invalid key "${keyName}": ${reason}`);
    this.name = 'InvalidKeyError';
  }
}

export class NoAgentKeysError extends Error {
  constructor() {
    super(
      'No ANTHROPIC_API_KEY_N entries found in keys env file. ' +
        'Expected at least one key matching ANTHROPIC_API_KEY_1, ANTHROPIC_API_KEY_2, etc.',
    );
    this.name = 'NoAgentKeysError';
  }
}

export class MissingJudgeKeyError extends Error {
  constructor() {
    super('JUDGE_API_KEY not found in keys env file');
    this.name = 'MissingJudgeKeyError';
  }
}

export class MissingModelError extends Error {
  constructor() {
    super('ANTHROPIC_MODEL not found in keys env file');
    this.name = 'MissingModelError';
  }
}

export interface KeyDistributorConfig {
  agentKeys: string[];
  judgeKey: string;
  modelVersion: string;
  telegramBotToken: string | null;
  telegramChatId: string | null;
}

/**
 * Validates that a key is non-empty and starts with `sk-ant-`.
 */
function validateApiKey(keyName: string, keyValue: string): void {
  if (!keyValue || keyValue.trim().length === 0) {
    throw new InvalidKeyError(keyName, 'Key is empty');
  }
  if (!keyValue.startsWith('sk-ant-')) {
    throw new InvalidKeyError(
      keyName,
      `Key must start with "sk-ant-", got "${keyValue.slice(0, 10)}..."`,
    );
  }
}

/**
 * Parses a simple .env file into key-value pairs.
 * Ignores comments (#) and blank lines.
 */
function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    entries.set(key, value);
  }
  return entries;
}

/**
 * Loads and validates keys from a `.env` file.
 * Extracts ANTHROPIC_API_KEY_N entries, JUDGE_API_KEY, and ANTHROPIC_MODEL.
 */
export async function loadKeys(
  keysEnvPath: string,
): Promise<KeyDistributorConfig> {
  let content: string;
  try {
    content = await readFile(keysEnvPath, 'utf-8');
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      throw new KeyFileNotFoundError(keysEnvPath);
    }
    throw error;
  }

  const entries = parseEnvFile(content);

  // Extract agent keys (ANTHROPIC_API_KEY_1, ANTHROPIC_API_KEY_2, etc.)
  const agentKeyPattern = /^ANTHROPIC_API_KEY_(\d+)$/;
  const agentKeys: { index: number; value: string }[] = [];

  for (const [key, value] of entries) {
    const match = key.match(agentKeyPattern);
    if (match) {
      const index = Number(match[1]);
      validateApiKey(key, value);
      agentKeys.push({ index, value });
    }
  }

  if (agentKeys.length === 0) {
    throw new NoAgentKeysError();
  }

  // Sort by index for deterministic ordering
  agentKeys.sort((a, b) => a.index - b.index);

  // Extract judge key
  const judgeKey = entries.get('JUDGE_API_KEY');
  if (!judgeKey) {
    throw new MissingJudgeKeyError();
  }
  validateApiKey('JUDGE_API_KEY', judgeKey);

  // Extract model version
  const modelVersion = entries.get('ANTHROPIC_MODEL');
  if (!modelVersion) {
    throw new MissingModelError();
  }

  // Extract optional Telegram config
  const telegramBotToken = entries.get('TELEGRAM_BOT_TOKEN') ?? null;
  const telegramChatId = entries.get('TELEGRAM_CHAT_ID') ?? null;

  return {
    agentKeys: agentKeys.map((k) => k.value),
    judgeKey,
    modelVersion,
    telegramBotToken,
    telegramChatId,
  };
}

/**
 * Round-robin key assignment: returns the key at agentIndex mod keyCount.
 */
export function getKeyForAgent(
  agentKeys: string[],
  agentIndex: number,
): string {
  if (agentKeys.length === 0) {
    throw new NoAgentKeysError();
  }
  return agentKeys[agentIndex % agentKeys.length]!;
}
