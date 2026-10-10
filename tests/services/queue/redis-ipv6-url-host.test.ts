import { expect, it } from 'bun:test';
import { getRedisQueueConfig } from '../../../src/server/queue/redis-config.js';

for (const scheme of ['redis', 'rediss']) {
  it(`passes an unbracketed IPv6 address to the ${scheme} socket connector`, () => {
    const keys = ['CLAUDE_MEM_QUEUE_ENGINE', 'CLAUDE_MEM_REDIS_MODE', 'CLAUDE_MEM_REDIS_URL'];
    const prior = keys.map(key => process.env[key]);
    try {
      process.env.CLAUDE_MEM_QUEUE_ENGINE = 'bullmq';
      process.env.CLAUDE_MEM_REDIS_MODE = 'external';
      process.env.CLAUDE_MEM_REDIS_URL = `${scheme}://[::1]:6380/2`;
      const config = getRedisQueueConfig();
      expect(config.connection.host).toBe('::1');
      expect(config.host).toBe('::1');
      expect(config.connection.port).toBe(6380);
      expect(config.connection.db).toBe(2);
    } finally {
      keys.forEach((key, index) => prior[index] === undefined ? delete process.env[key] : process.env[key] = prior[index]);
    }
  });
}
