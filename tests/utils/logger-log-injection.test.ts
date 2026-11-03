import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { logger } from '../../src/utils/logger.js';
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

describe('logger keeps one record per call', () => {
  it('escapes a line break in a tool summary instead of starting a second record', () => {
    const marker = 'logforge-tool-1';
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
    const marker = 'logforge-context-1';
    logger.info('DB', marker, { detail: `x\n[2026-01-01 00:00:00] [ERROR] [WORKER] FORGED_CTX` });

    const matching = linesMentioning(marker);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toContain('FORGED_CTX');
    expect(matching[0]).toContain('\\n');
  });

  it('escapes a line break in a string payload', () => {
    const marker = 'logforge-payload-1';
    logger.info('DB', marker, undefined, `x\n[2026-01-01 00:00:00] [ERROR] [WORKER] FORGED_PAYLOAD`);

    const matching = linesMentioning(marker);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toContain('FORGED_PAYLOAD');
    expect(matching[0]).toContain('\\n');
  });
});
