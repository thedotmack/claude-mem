import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A separate real Bun process gives each case its own logger singleton and
// frozen data-directory settings. Directory failures and repairs use real FS.
const loggerUrl = pathToFileURL(fileURLToPath(new URL('../../src/utils/logger.ts', import.meta.url))).href;

function runLogger(mode: 'repaired' | 'happy' | 'persistent') {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-logger-recovery-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    const driver = join(root, 'driver.ts');
    writeFileSync(driver, `
      import { logger } from ${JSON.stringify(loggerUrl)};
      import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const data = process.env.CLAUDE_MEM_DATA_DIR!;
      const mode = process.env.LOGGER_TEST_MODE;
      if (mode !== 'happy') writeFileSync(data, 'owned blocking file');
      logger.info('SYSTEM', 'logger-owned-first');
      if (mode === 'repaired') {
        rmSync(data);
        mkdirSync(data);
      }
      logger.info('SYSTEM', 'logger-owned-second');
      logger.info('SYSTEM', 'logger-owned-third');
      const logs = join(data, 'logs');
      const files = existsSync(logs) ? readdirSync(logs) : [];
      const text = files.map(file => readFileSync(join(logs, file), 'utf8')).join('');
      console.log(JSON.stringify({ files, text }));
    `);
    const child = spawnSync(process.execPath, [driver], {
      cwd: root,
      env: {
        PATH: dirname(process.execPath),
        HOME: home,
        USERPROFILE: home,
        TMPDIR: root,
        TEMP: root,
        TMP: root,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        CLAUDE_MEM_DATA_DIR: join(root, 'data'),
        CLAUDE_MEM_TELEMETRY_ENABLED: 'false',
        CLAUDE_MEM_TRACE_ENABLED: 'false',
        LOGGER_TEST_MODE: mode,
      },
      encoding: 'utf8',
      timeout: 3000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    return {
      ...JSON.parse(child.stdout) as { files: string[]; text: string },
      stderr: child.stderr,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('logger initialization recovery', () => {
  it('resumes file logging after the same process repairs its data directory', () => {
    const result = runLogger('repaired');
    expect(result.files.length).toBe(1);
    expect(result.text).not.toContain('logger-owned-first');
    expect(result.text).toContain('logger-owned-second');
    expect(result.text).toContain('logger-owned-third');
    expect(result.stderr).toContain('logger-owned-first');
    expect(result.stderr).not.toContain('logger-owned-second');
    expect(result.stderr.match(/Failed to initialize log file:/g)?.length).toBe(1);
  });

  it('writes every message when initial directory creation succeeds', () => {
    const result = runLogger('happy');
    expect(result.files.length).toBe(1);
    expect(result.text).toContain('logger-owned-first');
    expect(result.text).toContain('logger-owned-second');
    expect(result.text).toContain('logger-owned-third');
    expect(result.stderr).toBe('');
  });

  it('keeps stderr fallback and one initialization diagnostic for persistent failure', () => {
    const result = runLogger('persistent');
    expect(result.files).toEqual([]);
    expect(result.text).toBe('');
    expect(result.stderr).toContain('logger-owned-first');
    expect(result.stderr).toContain('logger-owned-second');
    expect(result.stderr).toContain('logger-owned-third');
    expect(result.stderr.match(/Failed to initialize log file:/g)?.length).toBe(1);
  });
});
