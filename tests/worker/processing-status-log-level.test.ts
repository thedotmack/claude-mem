import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');
const fixture = join(root, 'tests/fixtures/worker/processing-status-log-level.ts');

describe('processing-status logging (#4087)', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'claude-mem-processing-status-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  for (const modulePath of ['src/services/worker-service.ts', 'plugin/scripts/worker-service.cjs']) {
    for (const level of ['INFO', 'DEBUG']) {
      for (const queueDepth of [0, 3]) {
        it(`${modulePath}: ${level}, queue depth ${queueDepth}`, () => {
          if (level === 'DEBUG') {
            writeFileSync(join(home, 'settings.json'), JSON.stringify({ CLAUDE_MEM_LOG_LEVEL: level }));
          }
          const iterations = level === 'INFO' ? 5000 : 10;
          const result = spawnSync(process.execPath, [fixture, join(root, modulePath), String(queueDepth), String(iterations)], {
            env: {
              ...process.env,
              HOME: home,
              USERPROFILE: home,
              CLAUDE_CONFIG_DIR: join(home, '.claude'),
              CLAUDE_MEM_DATA_DIR: home,
              CLAUDE_MEM_MANAGED: 'false',
              CLAUDE_MEM_TELEMETRY: 'off',
              DO_NOT_TRACK: '1',
            },
            encoding: 'utf-8',
            timeout: 20000,
          });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual({
            count: iterations,
            event: { type: 'processing_status', isProcessing: queueDepth > 0, queueDepth },
            allEqual: true,
          });

          const logsDir = join(home, 'logs');
          const lines = existsSync(logsDir)
            ? readdirSync(logsDir).flatMap(file => readFileSync(join(logsDir, file), 'utf-8').split('\n'))
            : [];
          const statusLines = lines.filter(line => line.includes('Broadcasting processing status'));
          expect(statusLines.length).toBe(level === 'INFO' ? 0 : iterations);
          if (level === 'DEBUG') {
            expect(statusLines.every(line => line.includes('[DEBUG]'))).toBe(true);
          }
        }, 25000);
      }
    }
  }
});
