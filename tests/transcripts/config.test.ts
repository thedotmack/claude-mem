import { describe, expect, it } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import {
  CODEX_SAMPLE_SCHEMA,
  SAMPLE_CONFIG,
  filterNativeHookBackedCodexWatches,
  isNativeHookBackedCodexWatch,
  shouldSuppressNativeCodexAgentsContext,
} from '../../src/services/transcripts/config.js';
import type { TranscriptWatchConfig } from '../../src/services/transcripts/types.js';

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

  it('strips legacy Codex watches unless explicitly opted in', () => {
    const config: TranscriptWatchConfig = {
      version: 1,
      schemas: {
        codex: CODEX_SAMPLE_SCHEMA,
      },
      watches: [
        {
          name: 'codex',
          path: '~/.codex/sessions/**/*.jsonl',
          schema: 'codex',
          startAtEnd: true,
        },
        {
          name: 'custom',
          path: '~/custom/**/*.jsonl',
          schema: 'codex',
          startAtEnd: true,
        },
      ],
    };

    const filtered = filterNativeHookBackedCodexWatches(config, false);
    expect(filtered.removed).toBe(1);
    expect(filtered.config.watches.map(watch => watch.name)).toEqual(['custom']);

    const allowed = filterNativeHookBackedCodexWatches(config, true);
    expect(allowed.removed).toBe(0);
    expect(allowed.config.watches).toHaveLength(2);
  });
});
