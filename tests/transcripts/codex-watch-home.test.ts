import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, relative } from 'path';
import { runTranscriptCommand } from '../../src/services/transcripts/cli.js';
import { scopeNativeHookBackedCodexWatches, shouldSuppressNativeCodexAgentsContext } from '../../src/services/transcripts/config.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import type { TranscriptWatchConfig } from '../../src/services/transcripts/types.js';

const defaultSettings = {
  CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION: 'false',
  CLAUDE_MEM_CODEX_SUBAGENT_INGESTION: 'false',
  CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'false',
};
const envKeys = ['CODEX_HOME', ...Object.keys(defaultSettings)];

describe('native Codex watch gate with CODEX_HOME', () => {
  let root: string;
  let codexHome: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-watch-home-'));
    codexHome = join(root, ' custom codex ');
    mkdirSync(join(codexHome, 'sessions'), { recursive: true });
    savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    process.env.CODEX_HOME = codexHome;
    Object.assign(process.env, defaultSettings);
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  const configFor = (home: string): TranscriptWatchConfig => ({
    version: 1,
    watches: [{ name: 'codex', path: join(home, 'sessions', '**', '*.jsonl'), schema: { name: 'codex', events: [] } }],
  });

  for (const relativeOverride of [false, true]) {
    it(`applies the default-off gate to the selected ${relativeOverride ? 'relative' : 'absolute'} home`, () => {
      if (relativeOverride) process.env.CODEX_HOME = relative(process.cwd(), codexHome);
      const config = configFor(codexHome);
      config.watches.push({ name: 'archive', path: join(root, 'export', '**', '*.jsonl'), schema: 'codex' });
      const gated = scopeNativeHookBackedCodexWatches(config, defaultSettings);
      expect(gated.removed).toBe(1);
      expect(gated.config.watches.map(watch => watch.name)).toEqual(['archive']);
    });
  }

  it('limits the selected profile to subagents when only subagent capture is enabled', () => {
    const gated = scopeNativeHookBackedCodexWatches(configFor(codexHome), {
      ...defaultSettings, CLAUDE_MEM_CODEX_SUBAGENT_INGESTION: 'true',
    });
    expect(gated.scoped).toBe(1);
    expect(gated.config.watches[0]).toMatchObject({
      subagentOnly: true, subagentSource: { path: 'payload.source.subagent.thread_spawn' },
    });
  });

  it('retains the default-home gate when a configured profile is also selected', () => {
    const config = configFor(codexHome);
    const legacy = configFor(join(homedir(), '.codex')).watches[0];
    config.watches.push(legacy);
    const disabled = scopeNativeHookBackedCodexWatches(config, defaultSettings);
    expect(disabled.removed).toBe(2);
    expect(disabled.config.watches).toEqual([]);
    const subagents = scopeNativeHookBackedCodexWatches(config, {
      ...defaultSettings, CLAUDE_MEM_CODEX_SUBAGENT_INGESTION: 'true',
    });
    expect(subagents.scoped).toBe(2);
    expect(subagents.config.watches.every(watch => watch.subagentOnly)).toBe(true);
    expect(shouldSuppressNativeCodexAgentsContext({ ...legacy, context: { mode: 'agents' } })).toBe(true);
  });

  it('preserves explicit full ingestion and suppresses duplicate native AGENTS updates', () => {
    const config = configFor(codexHome);
    const gated = scopeNativeHookBackedCodexWatches(config, {
      ...defaultSettings, CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION: 'true',
    });
    expect(gated.config).toBe(config);
    expect(shouldSuppressNativeCodexAgentsContext({ ...config.watches[0], context: { mode: 'agents' } })).toBe(true);
  });

  it('does not start the actual transcript-watch command under default settings', async () => {
    const configPath = join(root, 'watch.json');
    writeFileSync(configPath, JSON.stringify({ ...configFor(codexHome), stateFile: join(root, 'state.json') }));
    const start = spyOn(TranscriptWatcher.prototype, 'start').mockImplementation(async () => {});
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const oldSignals = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, new Set(process.listeners(signal))]));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        runTranscriptCommand('watch', ['--config', configPath]),
        new Promise(resolve => { timer = setTimeout(() => resolve('started watching'), 500); }),
      ]);
      expect(outcome).toBe(1);
      expect(start).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join('\n')).toContain('native hooks capture top-level Codex sessions');
    } finally {
      clearTimeout(timer);
      start.mockRestore();
      log.mockRestore();
      for (const [signal, old] of oldSignals) {
        for (const listener of process.listeners(signal)) {
          if (!old.has(listener)) process.removeListener(signal, listener);
        }
      }
    }
  });
});
