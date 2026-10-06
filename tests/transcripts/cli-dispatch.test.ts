import { describe, it, expect, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runTranscriptCommand } from '../../src/services/transcripts/cli.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { parseWorkerServiceCommand } from '../../src/services/worker-service.js';

describe('npx claude-mem transcript watch fallback (2450)', () => {
  it('parseWorkerServiceCommand routes "transcript <sub>" argv to command=transcript + args=[sub, ...]', () => {
    const parsedWatch = parseWorkerServiceCommand(['transcript', 'watch']);
    expect(parsedWatch.command).toBe('transcript');
    expect(parsedWatch.args).toEqual(['watch']);

    const parsedInit = parseWorkerServiceCommand([
      'transcript',
      'init',
      '--config',
      '/tmp/example.json',
    ]);
    expect(parsedInit.command).toBe('transcript');
    expect(parsedInit.args).toEqual(['init', '--config', '/tmp/example.json']);

    const parsedValidate = parseWorkerServiceCommand(['transcript', 'validate']);
    expect(parsedValidate.command).toBe('transcript');
    expect(parsedValidate.args).toEqual(['validate']);
  });

  it('runTranscriptCommand("init", …) writes a default config (dispatch target works end-to-end)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'claude-mem-transcript-cli-'));
    const configPath = join(tmpDir, 'transcript-watch.json');
    try {
      const exitCode = await runTranscriptCommand('init', ['--config', configPath]);
      expect(exitCode).toBe(0);
      expect(existsSync(configPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(parsed).toHaveProperty('watches');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('transcript watch applies the worker\'s default-off Codex gate', () => {
  it('does not tail the canonical Codex watch with default settings, and says why', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'claude-mem-transcript-codex-gate-'));
    const configPath = join(tmpDir, 'transcript-watch.json');
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      stateFile: join(tmpDir, 'state.json'),
      // What older installers wrote: native hooks already capture these sessions.
      watches: [{ name: 'codex', path: '~/.codex/sessions/**/*.jsonl', schema: { name: 'codex', events: [] } }],
    }));
    // Never tail the real ~/.codex, even if the gate were missing.
    const start = spyOn(TranscriptWatcher.prototype, 'start').mockImplementation(async () => {});
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const outcome = await Promise.race([
        runTranscriptCommand('watch', ['--config', configPath]),
        new Promise(resolve => setTimeout(() => resolve('still watching'), 2000)),
      ]);
      expect(outcome).toBe(1);
      expect(start).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join('\n')).toContain('CLAUDE_MEM_CODEX_SUBAGENT_INGESTION=true');
    } finally {
      start.mockRestore();
      log.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
