import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { logger } from '../../src/utils/logger.js';
import { paths } from '../../src/shared/paths.js';

/**
 * Drives the real logger.info() and reads back the line it wrote to today's
 * log file under CLAUDE_MEM_DATA_DIR (pinned to a safe temp dir by
 * tests/preload.ts), matching the convention used by other tests that
 * exercise process-wide singletons via their real file output rather than a
 * hand-copied replica of private formatting logic.
 */
function lastLoggedLineFor(marker: string): string {
  const date = new Date().toISOString().split('T')[0];
  const logPath = `${paths.logsDir()}/claude-mem-${date}.log`;
  const content = readFileSync(logPath, 'utf8');
  const lines = content.split('\n').filter(line => line.includes(marker));
  return lines[lines.length - 1];
}

describe('logger context formatting', () => {
  it('should render an object context value as JSON, not [object Object]', () => {
    const marker = 'ctx-test-object-1';
    logger.info('SYSTEM', marker, { synced: { observationDocs: 3, summaryDocs: 1, promptDocs: 2 } });
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('{synced={"observationDocs":3,"summaryDocs":1,"promptDocs":2}}');
    expect(line).not.toContain('[object Object]');
  });

  it('should render an array of numbers context value as JSON', () => {
    const marker = 'ctx-test-array-1';
    logger.info('SYSTEM', marker, { items: [1, 2, 3] });
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('{items=[1,2,3]}');
    expect(line).not.toContain('[object Object]');
  });

  it('should render an array of strings context value as JSON', () => {
    const marker = 'ctx-test-array-strings-1';
    logger.info('SYSTEM', marker, { args: ['--version', '--foo'] });
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('{args=["--version","--foo"]}');
  });

  it('should render an array of objects context value as JSON', () => {
    const marker = 'ctx-test-array-objects-1';
    logger.info('SYSTEM', marker, { records: [{ a: 1 }, { b: 2 }] });
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('{records=[{"a":1},{"b":2}]}');
  });

  it('should render an empty array context value as []', () => {
    const marker = 'ctx-test-array-empty-1';
    logger.info('SYSTEM', marker, { items: [] });
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('{items=[]}');
  });

  it('should not throw on an array containing a circular-reference element, and print the fallback', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const marker = 'ctx-test-array-circular-1';
    expect(() => logger.info('SYSTEM', marker, { items: [circular] })).not.toThrow();
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('{items=[unserializable]}');
  });

  it('should leave string context values unchanged', () => {
    const marker = 'ctx-test-string-1';
    logger.info('SYSTEM', marker, { project: 'my-project' });
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('{project=my-project}');
  });

  it('should leave number context values unchanged', () => {
    const marker = 'ctx-test-number-1';
    logger.info('SYSTEM', marker, { count: 42 });
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('{count=42}');
  });

  it('should leave boolean context values unchanged', () => {
    const marker = 'ctx-test-boolean-1';
    logger.info('SYSTEM', marker, { enabled: true });
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('{enabled=true}');
  });

  it('should leave null context values unchanged', () => {
    const marker = 'ctx-test-null-1';
    logger.info('SYSTEM', marker, { value: null });
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('{value=null}');
  });

  it('should leave undefined context values unchanged', () => {
    const marker = 'ctx-test-undefined-1';
    logger.info('SYSTEM', marker, { value: undefined });
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('{value=undefined}');
  });

  it('should render an Error instance in context unchanged (single-line)', () => {
    const marker = 'ctx-test-error-1';
    logger.info('SYSTEM', marker, { err: new Error('boom') });
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('{err=Error: boom}');
    expect(line.split('\n').length).toBe(1);
  });

  it('should not throw on a circular-reference context value, and print the fallback', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const marker = 'ctx-test-circular-1';
    expect(() => logger.info('SYSTEM', marker, { circular })).not.toThrow();
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('{circular=[unserializable]}');
  });

  it('should not throw on a BigInt-containing context value, and print the fallback', () => {
    const marker = 'ctx-test-bigint-1';
    expect(() => logger.info('SYSTEM', marker, { withBigInt: { n: BigInt(5) } })).not.toThrow();
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('{withBigInt=[unserializable]}');
  });
});
