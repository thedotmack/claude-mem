import { expect, it } from 'bun:test';
import { getRedisQueueConfig } from '../../../src/server/queue/redis-config.js';

function configured(port: string, url: string, read: () => void) {
  const values = { CLAUDE_MEM_QUEUE_ENGINE: 'bullmq', CLAUDE_MEM_REDIS_MODE: 'external',
    CLAUDE_MEM_REDIS_PORT: port, CLAUDE_MEM_REDIS_URL: url };
  const prior = Object.keys(values).map(key => process.env[key]);
  try { Object.assign(process.env, values); read(); }
  finally { Object.keys(values).forEach((key, i) => prior[i] === undefined ? delete process.env[key] : process.env[key] = prior[i]); }
}
it('rejects port text that only begins with a valid integer', () => {
  for (const port of ['6379junk', '6379.5', '6e3']) {
    configured(port, '', () => expect(() => getRedisQueueConfig()).toThrow('Invalid CLAUDE_MEM_REDIS_PORT'));
  }
});
it('rejects fractional or suffixed Redis database paths', () => {
  for (const database of ['1.5', '1junk', '1e2']) {
    configured('6379', `redis://localhost/${database}`, () => expect(() => getRedisQueueConfig()).toThrow('Invalid Redis database'));
  }
});
it('retains decimal ports and database zero', () => {
  configured(' 6380 ', 'redis://localhost/0', () => {
    const config = getRedisQueueConfig();
    expect(config.connection.db).toBe(0);
    expect(config.connection.port).toBe(6379);
  });
});
