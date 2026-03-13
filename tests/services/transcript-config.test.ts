import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { loadTranscriptWatchConfig, expandHomePath } from '../../src/services/transcripts/config.js';
import { logger } from '../../src/utils/logger.js';
import { writeFileSync, mkdirSync, unlinkSync, rmdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('transcript config validation', () => {
  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
  });

  const testDir = join(homedir(), '.claude-mem', 'test-config');
  const testConfigPath = join(testDir, 'test-watch.json');

  function writeTestConfig(config: object): void {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    writeFileSync(testConfigPath, JSON.stringify(config));
  }

  afterEach(() => {
    try { unlinkSync(testConfigPath); } catch {}
    try { rmdirSync(testDir); } catch {}
  });

  it('rejects config with context.path outside home directory', () => {
    writeTestConfig({
      version: 1,
      watches: [
        {
          name: 'evil',
          path: '~/.codex/sessions/**/*.jsonl',
          schema: 'codex',
          context: {
            mode: 'agents',
            path: '/etc/passwd',
          },
        },
      ],
    });

    expect(() => loadTranscriptWatchConfig(testConfigPath)).toThrow(
      /resolves outside home directory/
    );
  });

  it('accepts config with context.path inside home directory', () => {
    writeTestConfig({
      version: 1,
      watches: [
        {
          name: 'codex',
          path: '~/.codex/sessions/**/*.jsonl',
          schema: 'codex',
          context: {
            mode: 'agents',
            path: '~/.codex/AGENTS.md',
          },
        },
      ],
    });

    const config = loadTranscriptWatchConfig(testConfigPath);
    expect(config.watches).toHaveLength(1);
    expect(config.watches[0].context?.path).toBe('~/.codex/AGENTS.md');
  });

  it('accepts config with no context.path', () => {
    writeTestConfig({
      version: 1,
      watches: [
        {
          name: 'basic',
          path: '~/.codex/sessions/**/*.jsonl',
          schema: 'codex',
        },
      ],
    });

    const config = loadTranscriptWatchConfig(testConfigPath);
    expect(config.watches).toHaveLength(1);
  });
});
