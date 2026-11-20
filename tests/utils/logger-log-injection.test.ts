import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { logger, LogLevel } from '../../src/utils/logger.js';
import { paths } from '../../src/shared/paths.js';

/**
 * A log value must never be able to start a second record. Tool input is
 * model/attacker-controlled text (a `Bash` command, a file path, a URL), and it
 * reaches `logger.info` through `formatTool`, through a context value, and as a
 * plain string payload. A raw line break in any of those split one record into
 * two, and the second one — a complete `[timestamp] [LEVEL] [COMPONENT]` line —
 * parses as a genuine entry in the viewer (LogsModal.parseLogLine) with an
 * attacker-chosen level and timestamp.
 *
 * Drives the real logger and reads back today's file, following the convention
 * in tests/utils/logger-format-context.test.ts.
 */
function linesMentioning(marker: string): string[] {
  const date = new Date().toISOString().split('T')[0];
  const logPath = `${paths.logsDir()}/claude-mem-${date}.log`;
  return readFileSync(logPath, 'utf8').split('\n').filter(line => line.includes(marker));
}

const FORGED_PREFIX = '[2026-01-01 00:00:00] [ERROR] [WORKER] ';

/** Each marker is unique per run, so a persistent CLAUDE_MEM_DATA_DIR can't hold an earlier run's lines. */
function uniqueMarker(label: string): string {
  return `logforge-${label}-${crypto.randomUUID()}`;
}

function forgedRecordsMentioning(forgedText: string): string[] {
  return linesMentioning(forgedText).filter(line => line.startsWith(FORGED_PREFIX));
}

function atDebugLevel(run: () => void): void {
  const levelHolder = logger as unknown as { level: LogLevel | null };
  const previousLevel = levelHolder.level;
  levelHolder.level = LogLevel.DEBUG;
  try {
    run();
  } finally {
    levelHolder.level = previousLevel;
  }
}

describe('logger keeps one record per call', () => {
  it('escapes a line break in a tool summary instead of starting a second record', () => {
    const marker = uniqueMarker('tool');
    const command = `echo ${marker}\n[2026-01-01 00:00:00] [ERROR] [WORKER] FORGED_TOOL`;
    logger.info('HOOK', `PostToolUse: ${logger.formatTool('Bash', { command })}`);

    const matching = linesMentioning(marker);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toContain('FORGED_TOOL');
    expect(matching[0]).toStartWith('[');
    // The forged text stayed inside the real record, escaped, rather than
    // becoming a line that begins with its own timestamp.
    expect(matching[0]).toContain('\\n');
  });

  it('escapes a line break in a context value', () => {
    const marker = uniqueMarker('context');
    logger.info('DB', marker, { detail: `x\n[2026-01-01 00:00:00] [ERROR] [WORKER] FORGED_CTX` });

    const matching = linesMentioning(marker);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toContain('FORGED_CTX');
    expect(matching[0]).toContain('\\n');
  });

  it('escapes a line break in a string payload', () => {
    const marker = uniqueMarker('payload');
    logger.info('DB', marker, undefined, `x\n[2026-01-01 00:00:00] [ERROR] [WORKER] FORGED_PAYLOAD`);

    const matching = linesMentioning(marker);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toContain('FORGED_PAYLOAD');
    expect(matching[0]).toContain('\\n');
  });

  it('escapes a line break in a key of a context object with more than 3 keys', () => {
    const marker = uniqueMarker('context-keys');
    const forged = `${marker}-FORGED`;
    logger.info('DB', 'context keys', {
      detail: { [`first\n${FORGED_PREFIX}${forged}`]: 1, second: 2, third: 3, fourth: 4 },
    });

    expect(forgedRecordsMentioning(forged)).toEqual([]);
    expect(linesMentioning(forged)).toHaveLength(1);
  });

  it('keeps an Error message with a line break inside its record at DEBUG', () => {
    const forged = `${uniqueMarker('debug-error')}-FORGED`;
    atDebugLevel(() => {
      logger.error('DB', 'debug error', undefined, new Error(`first\n${FORGED_PREFIX}${forged}`));
    });

    expect(forgedRecordsMentioning(forged)).toEqual([]);
  });

  it('keeps an Error message that only looks like a record inside its record at DEBUG', () => {
    const forged = `${uniqueMarker('debug-error-prefix')}-FORGED`;
    atDebugLevel(() => {
      logger.error('DB', 'debug error', undefined, new Error(`${FORGED_PREFIX}${forged}`));
    });

    expect(forgedRecordsMentioning(forged)).toEqual([]);
  });

  it('keeps a stack that starts with a record prefix from posing as a record at DEBUG', () => {
    const forged = `${uniqueMarker('debug-stack')}-FORGED`;
    const error = new Error('plain message');
    error.stack = `${FORGED_PREFIX}${forged}\n${FORGED_PREFIX}${forged}\n    at realFrame (real.ts:1:1)`;
    atDebugLevel(() => {
      logger.error('DB', 'debug stack', undefined, error);
    });

    expect(forgedRecordsMentioning(forged)).toEqual([]);
  });

  it('keeps the frames of a stack on their own lines at DEBUG', () => {
    const marker = uniqueMarker('debug-frames');
    const error = new Error(marker);
    error.stack = `Error: ${marker}\n    at ${marker}Frame (real.ts:1:1)\n    at ${marker}Caller (real.ts:2:2)`;
    atDebugLevel(() => {
      logger.error('DB', 'debug frames', undefined, error);
    });

    const frames = linesMentioning(marker).filter(line => line.startsWith('    at '));
    expect(frames).toEqual([
      `    at ${marker}Frame (real.ts:1:1)`,
      `    at ${marker}Caller (real.ts:2:2)`,
    ]);
  });
});
