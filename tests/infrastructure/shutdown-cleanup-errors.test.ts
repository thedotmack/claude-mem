import { test, expect, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { performGracefulShutdown } from '../../src/services/infrastructure/GracefulShutdown';
import { getSupervisor } from '../../src/supervisor';
import { logger } from '../../src/utils/logger';
import { paths } from '../../src/shared/paths';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

test('an MCP close rejection still closes the database and supervisor', async () => {
  const db = new Database(':memory:');
  const error = new Error('MCP connection closed during teardown');
  const supervisor = spyOn(getSupervisor(), 'stop').mockResolvedValue(undefined);
  try {
    await expect(performGracefulShutdown({
      server: null,
      sessionManager: { async shutdownAll() {} },
      mcpClient: { async close() { throw error; } },
      dbManager: { async close() { db.close(); } },
    })).rejects.toBe(error);
    expect(() => db.query('SELECT 1').get()).toThrow();
    expect(supervisor).toHaveBeenCalledTimes(1);
  } finally { db.close(); supervisor.mockRestore(); }
});

test('session and Chroma errors both survive while later cleanup completes', async () => {
  const first = new Error('session drain failed');
  const second = new Error('Chroma disconnected');
  const order: string[] = [];
  const supervisor = spyOn(getSupervisor(), 'stop').mockImplementation(async () => { order.push('supervisor'); });
  try {
    let failure: unknown;
    try {
      await performGracefulShutdown({
        server: null,
        sessionManager: { async shutdownAll() { throw first; } },
        mcpClient: { async close() { order.push('mcp'); } },
        chromaMcpManager: { async stop() { throw second; } },
        dbManager: { async close() { order.push('database'); } },
      });
    } catch (error) { failure = error; }
    expect(order).toEqual(['mcp', 'database', 'supervisor']);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([first, second]);
    logger.error('SYSTEM', 'Worker shutdown failed', {}, failure);
    const text = readdirSync(paths.logsDir()).filter(name => name.endsWith('.log')).map(name => readFileSync(join(paths.logsDir(), name), 'utf8')).join('\n');
    expect(text).toContain('sessions: session drain failed');
    expect(text).toContain('Chroma: Chroma disconnected');
  } finally { supervisor.mockRestore(); }
});
