import { describe, it, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runTranscriptCommand } from '../../src/services/transcripts/cli.js';
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
