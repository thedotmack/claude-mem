import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildGrokBotWatch, GROK_BOT_SCHEMA, installGrokBotIntegration } from '../../src/services/integrations/GrokBotInstaller.js';

const fixturePath = path.join(__dirname, '..', 'fixtures', 'grok-bot-session.jsonl');

describe('Grok Bot transcript integration', () => {
  it('defines tool_result events with toolId join keys', () => {
    const toolResult = GROK_BOT_SCHEMA.events.find((event) => event.name === 'grok-tool-result');
    expect(toolResult?.action).toBe('tool_result');
    expect(toolResult?.fields?.toolId).toBeDefined();
    expect(toolResult?.fields?.toolUseId).toBeDefined();
  });

  it('builds the expected agent-transcripts watch path', () => {
    const watch = buildGrokBotWatch('/tmp/example-repo');
    expect(watch.name).toBe('grok-bot');
    expect(watch.path).toBe(path.join('/tmp/example-repo', 'agent-transcripts', '*', '*.jsonl'));
    expect(watch.schema).toBe('grok-bot');
    expect(watch.workspace).toBe('/tmp/example-repo');
  });

  it('writes an idempotent transcript-watch config with the Grok Bot schema', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'grok-bot-config-'));
    const configPath = path.join(tempRoot, 'transcript-watch.json');
    try {
      expect(installGrokBotIntegration(configPath, '/tmp/example-repo')).toBe(0);
      expect(installGrokBotIntegration(configPath, '/tmp/example-repo')).toBe(0);

      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(parsed.schemas['grok-bot'].name).toBe('grok-bot');
      expect(parsed.watches).toHaveLength(1);
      expect(parsed.watches[0].path).toBe(path.join('/tmp/example-repo', 'agent-transcripts', '*', '*.jsonl'));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('ships a Grok Bot transcript fixture with tool_use and tool result lines', () => {
    const lines = readFileSync(fixturePath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0].role).toBe('assistant');
    expect(lines[0].message.content[0].type).toBe('tool_use');
    expect(lines[1].role).toBe('tool');
    expect(lines[1].message.content[0].toolUseId).toBe('toolu_123');
  });
});
