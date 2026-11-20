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
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  const when = new Date(0);

  it.each<[string, Record<string, unknown>, string]>([
    ['object', { synced: { observationDocs: 3, summaryDocs: 1, promptDocs: 2 } }, '{synced={"observationDocs":3,"summaryDocs":1,"promptDocs":2}}'],
    ['number array', { items: [1, 2, 3] }, '{items=[1,2,3]}'],
    ['string array', { args: ['--version', '--foo'] }, '{args=["--version","--foo"]}'],
    ['object array', { records: [{ a: 1 }, { b: 2 }] }, '{records=[{"a":1},{"b":2}]}'],
    ['empty array', { items: [] }, '{items=[]}'],
    ['circular array', { items: [circular] }, '{items=[{"a":1,"self":"[Circular]"}]}'],
    ['string', { project: 'my-project' }, '{project=my-project}'],
    ['number', { count: 42 }, '{count=42}'],
    ['boolean', { enabled: true }, '{enabled=true}'],
    ['null', { value: null }, '{value=null}'],
    ['undefined', { value: undefined }, '{value=undefined}'],
    ['Error', { err: new Error('boom') }, '{err=Error: boom}'],
    ['Date', { when }, `{when=${when}}`],
    ['circular object', { circular }, '{circular={"a":1,"self":"[Circular]"}}'],
    ['BigInt', { withBigInt: { n: BigInt(5) } }, '{withBigInt={"n":"5n"}}'],
  ])('renders %s context', (name, context, expected) => {
    const marker = `ctx-table-${name}`;
    expect(() => logger.info('SYSTEM', marker, context)).not.toThrow();
    const line = lastLoggedLineFor(marker);
    expect(line).toContain(expected);
    expect(line).not.toContain('[object Object]');
    expect(line.split('\n').length).toBe(1);
  });


  it('should render each Keychain command diagnostic in a warning line', () => {
    const marker = 'oauth-keychain-diagnostic-1';
    logger.warn('OAUTH', marker, {
      service: 'Claude Code-credentials',
      account: 'kirat',
      exitCode: 36,
      errorCode: null,
      signal: 'SIGTERM',
      stderr: 'User interaction is not allowed.',
    });
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('{service=Claude Code-credentials, account=kirat, exitCode=36, errorCode=null, signal=SIGTERM, stderr=User interaction is not allowed.}');
    expect(line).not.toContain('keys:');
  });

  it('should render both Keychain attempts in a warning line', () => {
    const marker = 'oauth-keychain-diagnostic-2';
    logger.warn('OAUTH', marker, {
      service: 'Claude Code-credentials',
      account: 'kirat',
      exitCode: 36,
      errorCode: null,
      signal: null,
      stderr: 'User interaction is not allowed.',
      searchListExitCode: 44,
      searchListErrorCode: null,
      searchListSignal: null,
      searchListStderr: 'The specified item could not be found in the keychain.',
    });
    const line = lastLoggedLineFor(marker);
    expect(line).toContain('exitCode=36');
    expect(line).toContain('stderr=User interaction is not allowed.');
    expect(line).toContain('searchListExitCode=44');
    expect(line).toContain('searchListStderr=The specified item could not be found in the keychain.');
    expect(line).not.toContain('keys:');
  });
});
