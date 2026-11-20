import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadTranscriptWatchConfig } from '../../src/services/transcripts/config.js';
import { loadWatchState } from '../../src/services/transcripts/state.js';
import { installGrokBotIntegration } from '../../src/services/integrations/GrokBotInstaller.js';
import { loadGrokBotIndexConfig, projectsForAgent } from '../../src/services/integrations/GrokBotIndexWriter.js';
import { stripLegacyTranscriptWatchContexts } from '../../src/services/integrations/CodexCliInstaller.js';

describe('BOM-prefixed transcript JSON documents', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function file(value: unknown, bom: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'transcript-bom-')); dirs.push(dir);
    const pathname = join(dir, 'document.json');
    writeFileSync(pathname, (bom ? '\uFEFF' : '') + JSON.stringify(value)); return pathname;
  }
  it('loads the configured watches from a UTF-8 BOM document', () => {
    const config = { version: 1, schemas: {}, watches: [{ name: 'codex', path: '/tmp/sessions/*.jsonl', schema: 'codex' }] };
    expect(loadTranscriptWatchConfig(file(config, true)).watches).toEqual(config.watches);
  });
  it('retains durable offsets and partial frames rather than replaying from zero', () => {
    const state = { offsets: { '/tmp/session.jsonl.zst': 4096 }, partials: { '/tmp/session.jsonl.zst': '{"event":' }, frameLines: { '/tmp/session.jsonl.zst': 2 }, cwds: { '/tmp/session.jsonl.zst': '/workspace' } };
    expect(loadWatchState(file(state, true))).toEqual(state);
  });
  it('keeps unprefixed JSON and invalid-config behavior', () => {
    expect(loadWatchState(file({ offsets: { example: 5 } }, false))).toEqual({ offsets: { example: 5 } });
    expect(() => loadTranscriptWatchConfig(file({ version: 1 }, true))).toThrow('Invalid transcript watch config');
  });

  // The installers and the Grok Bot INDEX writer read the same config file.
  it('lets the Grok Bot installer add its watch to a BOM config', () => {
    const configPath = file({ version: 1, schemas: {}, watches: [{ name: 'cursor', path: '/tmp/cursor.jsonl', schema: 'cursor' }] }, true);
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'transcript-bom-grok-')); dirs.push(workspaceRoot);
    expect(installGrokBotIntegration(configPath, workspaceRoot)).toBe(0);
    const written = JSON.parse(readFileSync(configPath, 'utf-8')) as { watches: Array<{ name: string }> };
    expect(written.watches.map(watch => watch.name)).toEqual(['cursor', 'grok-bot']);
  });
  it('maps a Grok Bot seat to the project its BOM config names', () => {
    const agentId = '11111111-2222-4333-8444-555555555555';
    const watchConfigFile = file({ watches: [{ name: 'grok-bot', agentId, project: 'cmem_work_custom' }] }, true);
    const cfg = loadGrokBotIndexConfig(file({}, false), { CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: watchConfigFile });
    expect(projectsForAgent(cfg, agentId, 'Seat')).toEqual(['cmem_work_custom']);
  });
  it('lets the Codex installer strip the legacy AGENTS.md context from a BOM config', () => {
    const legacyContext = { mode: 'agents', updateOn: ['session_start', 'session_end'] };
    const configPath = file({ version: 1, watches: [{ name: 'codex', path: '/tmp/sessions/*.jsonl', schema: 'codex', context: legacyContext }] }, true);
    stripLegacyTranscriptWatchContexts(configPath);
    const written = JSON.parse(readFileSync(configPath, 'utf-8')) as { watches: Array<{ context?: unknown }> };
    expect(written.watches[0].context).toBeUndefined();
  });
});
