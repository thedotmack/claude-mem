import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildGrokBotWatch, GROK_BOT_SCHEMA, installGrokBotIntegration, resolveGrokBotProject } from '../../src/services/integrations/GrokBotInstaller.js';

const fixturePath = path.join(__dirname, '..', 'fixtures', 'grok-bot-session.jsonl');

function writeAgent(root: string, agentId: string, name: string): void {
  mkdirSync(path.join(root, 'agents', agentId), { recursive: true });
  writeFileSync(path.join(root, 'agents', agentId, 'profile.json'), JSON.stringify({ name }));
  mkdirSync(path.join(root, 'agent-transcripts', agentId), { recursive: true });
}

describe('Grok Bot transcript integration', () => {
  it('defines tool_result events with toolId join keys', () => {
    const toolResult = GROK_BOT_SCHEMA.events.find((event) => event.name === 'grok-tool-result');
    expect(toolResult?.action).toBe('tool_result');
    expect(toolResult?.fields?.toolId).toBeDefined();
    expect(toolResult?.fields?.toolUseId).toBeDefined();
  });

  it('maps agent profile names to cmem_work_ project slugs', () => {
    expect(resolveGrokBotProject('Biff')).toBe('cmem_work_biff');
    expect(resolveGrokBotProject('New Bot')).toBe('cmem_work_new-bot');
    expect(resolveGrokBotProject('box')).toBe('cmem_work_root');
    expect(resolveGrokBotProject('workspace')).toBe('cmem_work_root');
    expect(resolveGrokBotProject('')).toBe('cmem_work_root');
  });

  it('builds the expected agent-transcripts watch path', () => {
    const watch = buildGrokBotWatch('/tmp/example-repo');
    expect(watch.name).toBe('grok-bot');
    expect(watch.path).toBe(path.join('/tmp/example-repo', 'agent-transcripts', '*', '*.jsonl'));
    expect(watch.schema).toBe('grok-bot');
    expect(watch.project).toBe('cmem_work_root');
    expect(watch.workspace).toBe(path.join('/tmp/example-repo', '.cmem-projects', 'cmem_work_root'));
    expect(watch.startAtEnd).toBe(true);
  });

  it('writes an idempotent transcript-watch config with the Grok Bot schema', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'grok-bot-config-'));
    const configPath = path.join(tempRoot, 'transcript-watch.json');
    const workspaceRoot = path.join(tempRoot, 'example-repo');
    mkdirSync(workspaceRoot);
    try {
      expect(installGrokBotIntegration(configPath, workspaceRoot)).toBe(0);
      expect(installGrokBotIntegration(configPath, workspaceRoot)).toBe(0);

      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(parsed.schemas['grok-bot'].name).toBe('grok-bot');
      expect(parsed.watches).toHaveLength(1);
      expect(parsed.watches[0].path).toBe(path.join(workspaceRoot, 'agent-transcripts', '*', '*.jsonl'));
      expect(parsed.watches[0].project).toBe('cmem_work_root');
      expect(parsed.watches[0].workspace).toBe(path.join(workspaceRoot, '.cmem-projects', 'cmem_work_root'));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('writes one watch per agent profile using cmem_work_ project names', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'grok-bot-agents-'));
    const configPath = path.join(tempRoot, 'transcript-watch.json');
    const workspaceRoot = path.join(tempRoot, 'agent-host');
    const biffId = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
    const newBotId = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
    try {
      writeAgent(workspaceRoot, biffId, 'Biff');
      writeAgent(workspaceRoot, newBotId, 'New Bot');
      writeAgent(workspaceRoot, 'sand-subagent-zzzz', 'Subagent');

      writeFileSync(configPath, JSON.stringify({
        version: 1,
        schemas: { cursor: { name: 'cursor', events: [] } },
        watches: [{ name: 'cursor', path: '/tmp/cursor.jsonl', schema: 'cursor' }],
      }));

      expect(installGrokBotIntegration(configPath, workspaceRoot)).toBe(0);
      expect(installGrokBotIntegration(configPath, workspaceRoot)).toBe(0);

      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(parsed.schemas.cursor.name).toBe('cursor');
      expect(parsed.schemas['grok-bot'].name).toBe('grok-bot');

      const grokWatches = parsed.watches.filter((watch: { name: string }) => watch.name === 'grok-bot');
      const otherWatches = parsed.watches.filter((watch: { name: string }) => watch.name !== 'grok-bot');
      expect(otherWatches).toHaveLength(1);
      expect(grokWatches).toHaveLength(2);

      const byProject = Object.fromEntries(
        grokWatches.map((watch: { project: string }) => [watch.project, watch]),
      );
      expect(byProject.cmem_work_biff.path).toBe(
        path.join(workspaceRoot, 'agent-transcripts', biffId, '*.jsonl'),
      );
      expect(byProject.cmem_work_biff.workspace).toBe(
        path.join(workspaceRoot, '.cmem-projects', 'cmem_work_biff'),
      );
      expect(byProject['cmem_work_new-bot'].path).toBe(
        path.join(workspaceRoot, 'agent-transcripts', newBotId, '*.jsonl'),
      );
      expect(byProject['cmem_work_new-bot'].workspace).toBe(
        path.join(workspaceRoot, '.cmem-projects', 'cmem_work_new-bot'),
      );

      expect(grokWatches.some((watch: { path: string }) => watch.path.includes(`${path.sep}*${path.sep}`))).toBe(false);
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
