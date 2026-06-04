// SPDX-License-Identifier: Apache-2.0
//
// #2572 — `server keys` must list active keys WITHOUT ever printing secrets
// (the raw key or its hash). We prove the pure serializer drops any secret
// column even when the input row carries one.

import { describe, expect, it } from 'bun:test';
import { serializeActiveServerKeyRow } from '../../src/server/runtime/ServerBetaService.js';

describe('server keys CLI — never prints secrets (#2572)', () => {
  it('emits only non-secret metadata and drops key_hash entirely', () => {
    const out = serializeActiveServerKeyRow({
      id: 'key-1',
      team_id: 'team-1',
      project_id: 'proj-1',
      scopes: ['memories:read', 'memories:write'],
      expires_at: null,
      last_used_at: new Date('2026-05-28T00:00:00.000Z'),
      created_at: new Date('2026-05-01T00:00:00.000Z'),
      // A secret that must NEVER survive serialization.
      key_hash: 'scrypt$16384$deadbeef$cafebabe',
    });

    expect(out.id).toBe('key-1');
    expect(out.status).toBe('active');
    expect(out.scopes).toEqual(['memories:read', 'memories:write']);

    // No secret field, under any name, may appear.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('key_hash');
    expect(serialized).not.toContain('keyHash');
    expect(serialized).not.toContain('scrypt$');
    expect(serialized).not.toContain('deadbeef');
    expect(Object.keys(out)).not.toContain('key_hash');
    expect(Object.keys(out)).not.toContain('keyHash');
  });
});
