import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import {
  loadKeys,
  getKeyForAgent,
  InvalidKeyError,
  NoAgentKeysError,
  MissingJudgeKeyError,
  MissingModelError,
  KeyFileNotFoundError,
} from '../src/key-distributor.js';

const TEMP_DIR = join(import.meta.dir, '..', '.test-tmp');

async function writeTempEnv(filename: string, content: string): Promise<string> {
  await mkdir(TEMP_DIR, { recursive: true });
  const filePath = join(TEMP_DIR, filename);
  await writeFile(filePath, content);
  return filePath;
}

async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Ignore if file doesn't exist
  }
}

describe('key-distributor', () => {
  describe('loadKeys', () => {
    test('parses valid env file correctly', async () => {
      const envContent = [
        'ANTHROPIC_API_KEY_1=sk-ant-key-one-xxx',
        'ANTHROPIC_API_KEY_2=sk-ant-key-two-yyy',
        'JUDGE_API_KEY=sk-ant-judge-zzz',
        'ANTHROPIC_MODEL=claude-opus-4-6',
        'TELEGRAM_BOT_TOKEN=123:ABC',
        'TELEGRAM_CHAT_ID=-100123',
      ].join('\n');

      const filePath = await writeTempEnv('valid.env', envContent);
      try {
        const keys = await loadKeys(filePath);
        expect(keys.agentKeys).toEqual([
          'sk-ant-key-one-xxx',
          'sk-ant-key-two-yyy',
        ]);
        expect(keys.judgeKey).toBe('sk-ant-judge-zzz');
        expect(keys.modelVersion).toBe('claude-opus-4-6');
        expect(keys.telegramBotToken).toBe('123:ABC');
        expect(keys.telegramChatId).toBe('-100123');
      } finally {
        await cleanupTempFile(filePath);
      }
    });

    test('agent keys are ordered by index number', async () => {
      const envContent = [
        'ANTHROPIC_API_KEY_3=sk-ant-third',
        'ANTHROPIC_API_KEY_1=sk-ant-first',
        'ANTHROPIC_API_KEY_2=sk-ant-second',
        'JUDGE_API_KEY=sk-ant-judge',
        'ANTHROPIC_MODEL=claude-opus-4-6',
      ].join('\n');

      const filePath = await writeTempEnv('ordered.env', envContent);
      try {
        const keys = await loadKeys(filePath);
        expect(keys.agentKeys).toEqual([
          'sk-ant-first',
          'sk-ant-second',
          'sk-ant-third',
        ]);
      } finally {
        await cleanupTempFile(filePath);
      }
    });

    test('rejects keys that do not start with sk-ant-', async () => {
      const envContent = [
        'ANTHROPIC_API_KEY_1=invalid-key-format',
        'JUDGE_API_KEY=sk-ant-judge',
        'ANTHROPIC_MODEL=claude-opus-4-6',
      ].join('\n');

      const filePath = await writeTempEnv('invalid-key.env', envContent);
      try {
        await expect(loadKeys(filePath)).rejects.toThrow(InvalidKeyError);
      } finally {
        await cleanupTempFile(filePath);
      }
    });

    test('rejects empty key values', async () => {
      const envContent = [
        'ANTHROPIC_API_KEY_1=',
        'JUDGE_API_KEY=sk-ant-judge',
        'ANTHROPIC_MODEL=claude-opus-4-6',
      ].join('\n');

      const filePath = await writeTempEnv('empty-key.env', envContent);
      try {
        await expect(loadKeys(filePath)).rejects.toThrow(InvalidKeyError);
      } finally {
        await cleanupTempFile(filePath);
      }
    });

    test('throws NoAgentKeysError when no agent keys are present', async () => {
      const envContent = [
        'JUDGE_API_KEY=sk-ant-judge',
        'ANTHROPIC_MODEL=claude-opus-4-6',
      ].join('\n');

      const filePath = await writeTempEnv('no-agent-keys.env', envContent);
      try {
        await expect(loadKeys(filePath)).rejects.toThrow(NoAgentKeysError);
      } finally {
        await cleanupTempFile(filePath);
      }
    });

    test('throws MissingJudgeKeyError when judge key is absent', async () => {
      const envContent = [
        'ANTHROPIC_API_KEY_1=sk-ant-key',
        'ANTHROPIC_MODEL=claude-opus-4-6',
      ].join('\n');

      const filePath = await writeTempEnv('no-judge.env', envContent);
      try {
        await expect(loadKeys(filePath)).rejects.toThrow(MissingJudgeKeyError);
      } finally {
        await cleanupTempFile(filePath);
      }
    });

    test('throws MissingModelError when model is absent', async () => {
      const envContent = [
        'ANTHROPIC_API_KEY_1=sk-ant-key',
        'JUDGE_API_KEY=sk-ant-judge',
      ].join('\n');

      const filePath = await writeTempEnv('no-model.env', envContent);
      try {
        await expect(loadKeys(filePath)).rejects.toThrow(MissingModelError);
      } finally {
        await cleanupTempFile(filePath);
      }
    });

    test('throws KeyFileNotFoundError for missing file', async () => {
      await expect(
        loadKeys('/nonexistent/path/keys.env'),
      ).rejects.toThrow(KeyFileNotFoundError);
    });

    test('ignores comment lines and blank lines', async () => {
      const envContent = [
        '# This is a comment',
        '',
        'ANTHROPIC_API_KEY_1=sk-ant-key-one',
        '',
        '# Another comment',
        'JUDGE_API_KEY=sk-ant-judge',
        'ANTHROPIC_MODEL=claude-opus-4-6',
      ].join('\n');

      const filePath = await writeTempEnv('comments.env', envContent);
      try {
        const keys = await loadKeys(filePath);
        expect(keys.agentKeys).toEqual(['sk-ant-key-one']);
      } finally {
        await cleanupTempFile(filePath);
      }
    });

    test('judge key is separate from agent key pool', async () => {
      const envContent = [
        'ANTHROPIC_API_KEY_1=sk-ant-agent-one',
        'ANTHROPIC_API_KEY_2=sk-ant-agent-two',
        'JUDGE_API_KEY=sk-ant-judge-key',
        'ANTHROPIC_MODEL=claude-opus-4-6',
      ].join('\n');

      const filePath = await writeTempEnv('separate-judge.env', envContent);
      try {
        const keys = await loadKeys(filePath);
        expect(keys.agentKeys).not.toContain(keys.judgeKey);
        expect(keys.judgeKey).toBe('sk-ant-judge-key');
      } finally {
        await cleanupTempFile(filePath);
      }
    });
  });

  describe('getKeyForAgent', () => {
    const testKeys = ['sk-ant-key-A', 'sk-ant-key-B', 'sk-ant-key-C'];

    test('returns correct key for each index with round-robin', () => {
      expect(getKeyForAgent(testKeys, 0)).toBe('sk-ant-key-A');
      expect(getKeyForAgent(testKeys, 1)).toBe('sk-ant-key-B');
      expect(getKeyForAgent(testKeys, 2)).toBe('sk-ant-key-C');
    });

    test('wraps around for indices beyond key count', () => {
      expect(getKeyForAgent(testKeys, 3)).toBe('sk-ant-key-A');
      expect(getKeyForAgent(testKeys, 4)).toBe('sk-ant-key-B');
      expect(getKeyForAgent(testKeys, 5)).toBe('sk-ant-key-C');
      expect(getKeyForAgent(testKeys, 6)).toBe('sk-ant-key-A');
    });

    test('throws NoAgentKeysError for empty keys array', () => {
      expect(() => getKeyForAgent([], 0)).toThrow(NoAgentKeysError);
    });
  });
});
