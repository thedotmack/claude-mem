import { describe, expect, it } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import {
  SAMPLE_CONFIG,
  expandHomePath,
  scopeNativeHookBackedCodexWatches,
  isNativeHookBackedCodexWatch,
  shouldSuppressNativeCodexAgentsContext,
  type CodexWatchSettings,
} from '../../src/services/transcripts/config.js';
import type { TranscriptSchema, TranscriptWatchConfig } from '../../src/services/transcripts/types.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

const CODEX_SAMPLE_SCHEMA: TranscriptSchema = { name: 'codex', events: [] };

describe('transcript watcher config', () => {
  it('does not auto-watch Codex transcripts in the sample config', () => {
    expect(SAMPLE_CONFIG.watches).toEqual([]);
  });

  it('recognizes the legacy Codex session transcript watch', () => {
    expect(isNativeHookBackedCodexWatch({
      name: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
      schema: 'codex',
    })).toBe(true);

    expect(isNativeHookBackedCodexWatch({
      name: 'codex',
      path: join(homedir(), '.codex', 'sessions', '**', '*.jsonl'),
      schema: CODEX_SAMPLE_SCHEMA,
    })).toBe(true);
  });

  it('does not treat custom transcript watches as native Codex hooks', () => {
    expect(isNativeHookBackedCodexWatch({
      name: 'codex-archive',
      path: '~/custom-codex-export/**/*.jsonl',
      schema: 'codex',
    })).toBe(false);

    expect(isNativeHookBackedCodexWatch({
      name: 'other',
      path: '~/.codex/sessions/**/*.jsonl',
      schema: 'other',
    })).toBe(false);
  });

  it('still treats canonical Codex paths as hook-backed when either name or schema is Codex', () => {
    expect(isNativeHookBackedCodexWatch({
      name: 'other',
      path: '~/.codex/sessions/**/*.jsonl',
      schema: 'codex',
    })).toBe(true);

    expect(isNativeHookBackedCodexWatch({
      name: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
      schema: 'custom-schema',
    })).toBe(true);
  });

  it('suppresses native Codex transcript AGENTS context updates', () => {
    expect(shouldSuppressNativeCodexAgentsContext({
      name: 'codex',
      schema: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
      context: {
        mode: 'agents',
      },
    })).toBe(true);
  });

  it('does not suppress non-native or non-Codex AGENTS context updates', () => {
    expect(shouldSuppressNativeCodexAgentsContext({
      name: 'codex-archive',
      schema: 'codex',
      path: '~/custom-codex-export/**/*.jsonl',
      context: {
        mode: 'agents',
      },
    })).toBe(false);

    expect(shouldSuppressNativeCodexAgentsContext({
      name: 'other',
      schema: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
      context: {
        mode: 'agents',
      },
    })).toBe(false);

    expect(shouldSuppressNativeCodexAgentsContext({
      name: 'codex',
      schema: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
      context: {
        mode: 'agents-legacy',
      },
    })).toBe(false);
  });

  const codexWatchConfig = (): TranscriptWatchConfig => ({
    version: 1,
    schemas: { codex: CODEX_SAMPLE_SCHEMA },
    watches: [
      { name: 'codex', path: '~/.codex/sessions/**/*.jsonl', schema: 'codex', startAtEnd: true },
      { name: 'custom', path: '~/custom/**/*.jsonl', schema: 'codex', startAtEnd: true },
    ],
  });
  const watchSettings = (overrides: Partial<CodexWatchSettings> = {}): CodexWatchSettings => ({
    CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION: 'false',
    CLAUDE_MEM_CODEX_SUBAGENT_INGESTION: 'false',
    CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'false',
    ...overrides,
  });

  // Wave 3 gate R4-5: capturing Codex subagents from their rollouts is observer
  // spend that did not exist before #3655 (the native watch was removed
  // outright), so it is opt-in.
  it('removes the native Codex watch by default, leaving other watches alone', () => {
    const result = scopeNativeHookBackedCodexWatches(codexWatchConfig(), watchSettings());
    expect(result.removed).toBe(1);
    expect(result.scoped).toBe(0);
    expect(result.config.watches.map(watch => watch.name)).toEqual(['custom']);
    expect(result.config.watches[0].subagentOnly).toBeUndefined();
  });

  it('scopes the native Codex watch to subagent rollouts when opted in', () => {
    const result = scopeNativeHookBackedCodexWatches(codexWatchConfig(), watchSettings({ CLAUDE_MEM_CODEX_SUBAGENT_INGESTION: 'true' }));
    expect(result.scoped).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.config.watches.map(watch => watch.name)).toEqual(['codex', 'custom']);
    const codexWatch = result.config.watches.find(watch => watch.name === 'codex');
    expect(codexWatch?.subagentOnly).toBe(true);
    expect(codexWatch?.subagentSource).toEqual({ path: 'payload.source.subagent.thread_spawn' });
    // A non-native custom watch is left untouched.
    expect(result.config.watches.find(watch => watch.name === 'custom')?.subagentOnly).toBeUndefined();
  });

  it('keeps it removed when subagent observations are switched off (#2736), even when opted in', () => {
    const result = scopeNativeHookBackedCodexWatches(codexWatchConfig(), watchSettings({
      CLAUDE_MEM_CODEX_SUBAGENT_INGESTION: 'true',
      CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'true',
    }));
    expect(result.removed).toBe(1);
    expect(result.scoped).toBe(0);
    expect(result.config.watches.map(watch => watch.name)).toEqual(['custom']);
  });

  it('leaves every watch untouched under the full-ingestion opt-in', () => {
    for (const overrides of [{}, { CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'true' }, { CLAUDE_MEM_CODEX_SUBAGENT_INGESTION: 'true' }]) {
      const result = scopeNativeHookBackedCodexWatches(codexWatchConfig(), watchSettings({
        CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION: 'true',
        ...overrides,
      }));
      expect(result.scoped).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.config.watches).toHaveLength(2);
      expect(result.config.watches.every(watch => watch.subagentOnly === undefined)).toBe(true);
    }
  });

  it('ships with Codex subagent capture off', () => {
    expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_CODEX_SUBAGENT_INGESTION).toBe('false');
  });
});

describe('expandHomePath', () => {
  it('expands a bare ~ and a ~/ prefix to the current home directory', () => {
    expect(expandHomePath('~')).toBe(homedir());
    expect(expandHomePath('~/.codex/sessions')).toBe(join(homedir(), '.codex/sessions'));
  });

  it('expands the Windows ~\\ form only on win32', () => {
    // expandHome treats `~\` as a home prefix on Windows only; on POSIX a
    // backslash is a legal filename character and must stay literal.
    if (process.platform === 'win32') {
      expect(expandHomePath('~\\')).toBe(homedir());
      expect(expandHomePath('~\\.codex\\sessions')).toBe(join(homedir(), '.codex\\sessions'));
    } else {
      expect(expandHomePath('~\\')).toBe('~\\');
      expect(expandHomePath('~\\.codex\\sessions')).toBe('~\\.codex\\sessions');
    }
  });

  it('leaves ~user/ paths alone instead of reparenting them under this user home', () => {
    // `~alice/transcripts` names alice's home, not a directory inside ours.
    // Rewriting it to <home>/alice/transcripts pointed the watcher at a path
    // that does not exist, and it ingested nothing without reporting an error.
    expect(expandHomePath('~alice/transcripts')).toBe('~alice/transcripts');
    expect(expandHomePath('~backup/rollout.jsonl')).toBe('~backup/rollout.jsonl');
  });

  it('passes absolute, relative and empty paths through untouched', () => {
    expect(expandHomePath('/var/log/codex.jsonl')).toBe('/var/log/codex.jsonl');
    expect(expandHomePath('relative/path.jsonl')).toBe('relative/path.jsonl');
    expect(expandHomePath('')).toBe('');
  });
});
