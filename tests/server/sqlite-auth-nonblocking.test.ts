import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { requireServerAuth } from '../../src/server/middleware/auth.js';
import { createServerApiKey, createRawServerApiKey, hashServerApiKeyLegacySha256 } from '../../src/server/auth/sqlite-api-key-service.js';
import { AuthRepository } from '../../src/storage/sqlite/index.js';

describe('SQLite HTTP authentication yields during key derivation', () => {
  let db: Database;
  let server: Server;
  let base: string;
  let duringVerification: () => void;
  let events: string[];
  beforeEach(async () => {
    db = new Database(':memory:');
    new AuthRepository(db);
    events = [];
    duringVerification = () => {};
    const app = express();
    app.get('/protected', (_req, _res, next) => {
      const pendingEvents = events;
      const change = duringVerification;
      setImmediate(() => { pendingEvents.push('event-loop'); change(); });
      next();
    }, requireServerAuth(() => db, { requiredScopes: ['memories:read'] }), (req, res) => {
      events.push('authorized');
      res.json({ keyId: req.authContext?.apiKeyId });
    });
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  });
  const request = (key: string) => fetch(base + '/protected', { headers: { authorization: `Bearer ${key}` } });

  test('salted verification lets pending event-loop work run before authorization', async () => {
    const key = createServerApiKey(db, { name: 'responsive' });
    const response = await request(key.rawKey);
    expect(response.status).toBe(200);
    expect((await response.json()).keyId).toBe(key.record.id);
    expect(events).toEqual(['event-loop', 'authorized']);
  });

  test('legacy upgrade also derives off the event loop', async () => {
    const rawKey = createRawServerApiKey();
    const repo = new AuthRepository(db);
    const record = repo.createApiKey({ name: 'legacy', keyHash: hashServerApiKeyLegacySha256(rawKey),
      prefix: rawKey.slice(0, 10), scopes: ['memories:read'] });
    const response = await request(rawKey);
    expect(response.status).toBe(200);
    expect(events).toEqual(['event-loop', 'authorized']);
    expect(repo.getApiKeyById(record.id)?.keyHash).toStartWith('scrypt$');
  });

  for (const change of ['revoke', 'scope', 'expiry', 'hash'] as const) {
    test(`a ${change} change during derivation is enforced before authorization`, async () => {
      const key = createServerApiKey(db, { name: change });
      duringVerification = () => {
        const repo = new AuthRepository(db);
        if (change === 'revoke') repo.revokeApiKey(key.record.id);
        else if (change === 'scope') repo.updateApiKeyScopes(key.record.id, []);
        else if (change === 'expiry') db.prepare('UPDATE api_keys SET expires_at_epoch = 1 WHERE id = ?').run(key.record.id);
        else repo.updateApiKeyHash(key.record.id, hashServerApiKeyLegacySha256('replacement'));
      };
      const response = await request(key.rawKey);
      expect(response.status).toBe(403);
      expect(events).toEqual(['event-loop']);
      expect(new AuthRepository(db).getApiKeyById(key.record.id)?.lastUsedAtEpoch).toBeNull();
    });
  }

  test('simultaneous first uses of a legacy key both authenticate', async () => {
    const rawKey = createRawServerApiKey();
    new AuthRepository(db).createApiKey({ name: 'concurrent legacy', keyHash: hashServerApiKeyLegacySha256(rawKey),
      prefix: rawKey.slice(0, 10), scopes: ['memories:read'] });
    const responses = await Promise.all([request(rawKey), request(rawKey)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
  });

  test('a saturated shared KDF queue returns retryable HTTP 503', async () => {
    const key = createServerApiKey(db, { name: 'bounded queue' });
    const responses = await Promise.all(Array.from({ length: 100 }, () => request(key.rawKey)));
    expect(responses.some(response => response.status === 503)).toBe(true);
    for (const response of responses) {
      expect([200, 503]).toContain(response.status);
      if (response.status === 503) expect(response.headers.get('retry-after')).toBe('1');
      await response.text();
    }
  }, 20000);
});
