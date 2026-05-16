import { describe, it, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runTranscriptCommand } from '../../src/services/transcripts/cli.js';

const workerServiceSource = readFileSync(
  join(__dirname, '..', '..', 'src', 'services', 'worker-service.ts'),
  'utf-8',
);

describe('npx claude-mem transcript watch fallback (#2450)', () => {
  it('worker-service main() routes the transcript subcommand into runTranscriptCommand', async () => {
    expect(workerServiceSource).toMatch(/case 'transcript':/);
    expect(workerServiceSource).toMatch(
      /import\(['"]\.\/transcripts\/cli\.js['"]\)/,
    );
    expect(workerServiceSource).toMatch(
      /runTranscriptCommand\(commandArgs\[0\], commandArgs\.slice\(1\)\)/,
    );

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
