import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
      expect(grokWatches).toHaveLength(3);

      const byProject = Object.fromEntries(
        grokWatches.map((watch: { project: string; path: string }) => [watch.project, watch]),
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
      expect(byProject.cmem_work_root.path).toBe(
        path.join(workspaceRoot, 'agent-transcripts', '*', '*.jsonl'),
      );

      expect(grokWatches.some((watch: { path: string }) => watch.path.includes(`${path.sep}*${path.sep}`))).toBe(true);
      expect(grokWatches.some((watch: { path: string }) => watch.path.includes('sand-subagent-'))).toBe(false);
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

  it('no-arg install watches a well-known agent-data directory instead of cwd', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'grok-bot-discover-'));
    const fakeHome = path.join(tempRoot, 'home');
    const agentData = path.join(fakeHome, '.grok-bot');
    const installCwd = path.join(tempRoot, 'workspace-a');
    const agentId = 'aaaaaaaa-bbbb-cccc-dddd-333333333333';
    const configPath = path.join(tempRoot, 'transcript-watch.json');
    const previousHome = process.env.HOME;
    const previousAgentData = process.env.GROK_BOT_AGENT_DATA;
    const previousCwd = process.cwd();
    try {
      mkdirSync(installCwd, { recursive: true });
      writeAgent(agentData, agentId, 'Alpha');
      process.env.HOME = fakeHome;
      delete process.env.GROK_BOT_AGENT_DATA;
      process.chdir(installCwd);

      expect(installGrokBotIntegration(configPath)).toBe(0);

      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      const grokWatches = parsed.watches.filter((watch: { name: string }) => watch.name === 'grok-bot');
      expect(grokWatches).toHaveLength(2);
      expect(grokWatches.map((watch: { path: string }) => watch.path)).toEqual([
        path.join(agentData, 'agent-transcripts', agentId, '*.jsonl'),
        path.join(agentData, 'agent-transcripts', '*', '*.jsonl'),
      ]);
      expect(grokWatches[0].project).toBe('cmem_work_alpha');
      expect(grokWatches[1].project).toBe('cmem_work_root');
      expect(grokWatches.every((watch: { path: string }) => watch.path.startsWith(agentData))).toBe(true);
      expect(grokWatches.every((watch: { path: string }) => watch.path.includes(installCwd))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousAgentData === undefined) delete process.env.GROK_BOT_AGENT_DATA;
      else process.env.GROK_BOT_AGENT_DATA = previousAgentData;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('covers agents created after install with the catch-all glob', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'grok-bot-catchall-'));
    const configPath = path.join(tempRoot, 'transcript-watch.json');
    const workspaceRoot = path.join(tempRoot, 'agent-host');
    const alphaId = 'aaaaaaaa-bbbb-cccc-dddd-555555555555';
    const betaId = 'aaaaaaaa-bbbb-cccc-dddd-666666666666';
    try {
      writeAgent(workspaceRoot, alphaId, 'Alpha');
      expect(installGrokBotIntegration(configPath, workspaceRoot)).toBe(0);

      writeAgent(workspaceRoot, betaId, 'Beta');
      const betaTranscript = path.join(workspaceRoot, 'agent-transcripts', betaId, 'new.jsonl');
      writeFileSync(betaTranscript, '{"role":"user"}\n');

      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      const grokWatches = parsed.watches.filter((watch: { name: string }) => watch.name === 'grok-bot');
      const catchAll = grokWatches.find((watch: { path: string }) =>
        watch.path.includes(`${path.sep}*${path.sep}`) && watch.path.endsWith('*.jsonl'),
      ) as { path: string } | undefined;
      expect(catchAll).toBeDefined();
      if (!catchAll) {
        throw new Error('expected a grok-bot catch-all watch covering agent-transcripts/*/*.jsonl');
      }
      expect(catchAll.path).toBe(path.join(workspaceRoot, 'agent-transcripts', '*', '*.jsonl'));

      const matches = Array.from(new Bun.Glob(catchAll.path.replace(/\\/g, '/')).scanSync({
        absolute: true,
        onlyFiles: true,
      }));
      expect(matches.some((file) => file.replace(/\\/g, '/').endsWith(`agent-transcripts/${betaId}/new.jsonl`))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('creates missing agent transcript directories so glob watches do not abort', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'grok-bot-mkdir-'));
    const configPath = path.join(tempRoot, 'transcript-watch.json');
    const workspaceRoot = path.join(tempRoot, 'agent-host');
    const agentId = 'aaaaaaaa-bbbb-cccc-dddd-444444444444';
    try {
      mkdirSync(path.join(workspaceRoot, 'agents', agentId), { recursive: true });
      writeFileSync(path.join(workspaceRoot, 'agents', agentId, 'profile.json'), JSON.stringify({ name: 'Delta' }));
      mkdirSync(path.join(workspaceRoot, 'agent-transcripts'), { recursive: true });

      expect(installGrokBotIntegration(configPath, workspaceRoot)).toBe(0);
      expect(existsSync(path.join(workspaceRoot, 'agent-transcripts', agentId))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
