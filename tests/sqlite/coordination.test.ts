/**
 * Coordination module tests
 * Tests file claiming, conflict detection, discovery sharing, and cleanup
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  claimFiles,
  releaseFiles,
  recordDiscovery,
  resolveConflict,
  cleanupExpiredClaims,
  checkConflicts,
  getActiveClaims,
  getDiscoveries,
} from '../../src/services/sqlite/Coordination.js';
import type { Database } from 'bun:sqlite';

describe('Coordination Module', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  // Test 1: Basic lifecycle — claim, verify active, release, verify released
  describe('claim lifecycle', () => {
    it('should claim files, verify active, release, and verify released', () => {
      const result = claimFiles(db, {
        agent_id: 'agent-1',
        agent_name: 'Test Agent',
        files: ['src/foo.ts', 'src/bar.ts'],
        scope: 'write',
        ttl_minutes: 30,
      });

      expect(result.claim_ids).toHaveLength(2);
      expect(result.conflicts).toHaveLength(0);

      // Verify active
      const active = getActiveClaims(db, 'agent-1');
      expect(active).toHaveLength(2);
      expect(active.map(c => c.file_path).sort()).toEqual(['src/bar.ts', 'src/foo.ts']);

      // Release
      const releaseResult = releaseFiles(db, 'agent-1', ['src/foo.ts', 'src/bar.ts']);
      expect(releaseResult.released_count).toBe(2);

      // Verify released
      const afterRelease = getActiveClaims(db, 'agent-1');
      expect(afterRelease).toHaveLength(0);
    });
  });

  // Test 2: TTL expiry
  describe('TTL expiry', () => {
    it('should clean up expired claims', () => {
      // Claim with TTL=0 effectively (set expires in the past manually)
      claimFiles(db, {
        agent_id: 'agent-1',
        agent_name: 'Test Agent',
        files: ['src/expired.ts'],
        scope: 'write',
        ttl_minutes: 0,
      });

      // Force expires_at to be in the past
      db.prepare(`
        UPDATE agent_coordination_claims
        SET expires_at_epoch = ?
        WHERE agent_id = 'agent-1'
      `).run(Date.now() - 1000);

      const cleaned = cleanupExpiredClaims(db);
      expect(cleaned).toBe(1);

      const active = getActiveClaims(db, 'agent-1');
      expect(active).toHaveLength(0);
    });
  });

  // Test 3: Write-write conflict detection
  describe('write-write conflict', () => {
    it('should detect write-write conflicts between agents', () => {
      // Agent A claims write
      claimFiles(db, {
        agent_id: 'agent-a',
        agent_name: 'Agent A',
        files: ['src/shared.ts'],
        scope: 'write',
        ttl_minutes: 30,
      });

      // Agent B claims write on same file
      const result = claimFiles(db, {
        agent_id: 'agent-b',
        agent_name: 'Agent B',
        files: ['src/shared.ts'],
        scope: 'write',
        ttl_minutes: 30,
      });

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].conflict_type).toBe('write_write');
      expect(result.conflicts[0].agent_a_id).toBe('agent-b');
      expect(result.conflicts[0].agent_b_id).toBe('agent-a');
    });
  });

  // Test 4: Read-write coexistence (no conflict for reads)
  describe('read-write coexistence', () => {
    it('should not detect conflicts when one agent reads and another writes', () => {
      // Agent A claims read
      claimFiles(db, {
        agent_id: 'agent-a',
        agent_name: 'Agent A',
        files: ['src/shared.ts'],
        scope: 'read',
        ttl_minutes: 30,
      });

      // Agent B claims write — no conflict because read claims don't trigger detection
      const result = claimFiles(db, {
        agent_id: 'agent-b',
        agent_name: 'Agent B',
        files: ['src/shared.ts'],
        scope: 'write',
        ttl_minutes: 30,
      });

      expect(result.conflicts).toHaveLength(0);
    });
  });

  // Test 5: Partial release
  describe('partial release', () => {
    it('should release only specified files', () => {
      claimFiles(db, {
        agent_id: 'agent-1',
        agent_name: 'Test Agent',
        files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
        scope: 'write',
        ttl_minutes: 30,
      });

      const result = releaseFiles(db, 'agent-1', ['a.ts', 'b.ts', 'c.ts']);
      expect(result.released_count).toBe(3);

      const active = getActiveClaims(db, 'agent-1');
      expect(active).toHaveLength(2);
      expect(active.map(c => c.file_path).sort()).toEqual(['d.ts', 'e.ts']);
    });
  });

  // Test 6: Atomicity — two claims in transaction
  describe('atomicity', () => {
    it('should handle sequential claims atomically', () => {
      const result1 = claimFiles(db, {
        agent_id: 'agent-1',
        agent_name: 'Agent 1',
        files: ['x.ts'],
        scope: 'write',
        ttl_minutes: 30,
      });

      const result2 = claimFiles(db, {
        agent_id: 'agent-2',
        agent_name: 'Agent 2',
        files: ['y.ts'],
        scope: 'write',
        ttl_minutes: 30,
      });

      expect(result1.claim_ids).toHaveLength(1);
      expect(result2.claim_ids).toHaveLength(1);

      const allActive = getActiveClaims(db);
      expect(allActive).toHaveLength(2);
    });
  });

  // Test 7: Discovery CRUD
  describe('discovery CRUD', () => {
    it('should record and query discoveries by session, file, and agent', () => {
      const id = recordDiscovery(db, {
        agent_id: 'agent-1',
        agent_name: 'Scanner',
        discovery_type: 'finding',
        content: 'Found unused import in utils.ts',
        affected_files: ['src/utils.ts'],
        severity: 'warning',
        session_id: 'session-abc',
      });

      expect(id).toBeGreaterThan(0);

      // Query by session
      const bySession = getDiscoveries(db, { session_id: 'session-abc' });
      expect(bySession).toHaveLength(1);
      expect(bySession[0].content).toBe('Found unused import in utils.ts');

      // Query by affected file
      const byFile = getDiscoveries(db, { affected_file: 'src/utils.ts' });
      expect(byFile).toHaveLength(1);

      // Query by agent
      const byAgent = getDiscoveries(db, { agent_id: 'agent-1' });
      expect(byAgent).toHaveLength(1);

      // Query with no match
      const noMatch = getDiscoveries(db, { agent_id: 'nonexistent' });
      expect(noMatch).toHaveLength(0);
    });
  });

  // Test 8: Conflict resolution
  describe('conflict resolution', () => {
    it('should create and resolve conflicts', () => {
      // Create conflict via overlapping write claims
      claimFiles(db, {
        agent_id: 'agent-a',
        agent_name: 'Agent A',
        files: ['conflict.ts'],
        scope: 'write',
        ttl_minutes: 30,
      });

      const result = claimFiles(db, {
        agent_id: 'agent-b',
        agent_name: 'Agent B',
        files: ['conflict.ts'],
        scope: 'write',
        ttl_minutes: 30,
      });

      expect(result.conflicts).toHaveLength(1);
      const conflictId = result.conflicts[0].id;

      // Resolve it
      const resolved = resolveConflict(db, conflictId, 'agent_a_priority');
      expect(resolved).toBe(true);

      // Verify cannot resolve again
      const resolvedAgain = resolveConflict(db, conflictId, 'dismissed');
      expect(resolvedAgain).toBe(false);
    });
  });

  // Test 9: Idempotent re-claim (old auto-released)
  describe('idempotent re-claim', () => {
    it('should auto-release old claim when same agent re-claims same file', () => {
      const first = claimFiles(db, {
        agent_id: 'agent-1',
        agent_name: 'Agent 1',
        files: ['src/main.ts'],
        scope: 'write',
        ttl_minutes: 30,
      });

      const second = claimFiles(db, {
        agent_id: 'agent-1',
        agent_name: 'Agent 1',
        files: ['src/main.ts'],
        scope: 'write',
        ttl_minutes: 60,
      });

      // Only one active claim should exist
      const active = getActiveClaims(db, 'agent-1');
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(second.claim_ids[0]);

      // First claim should be released
      const allClaims = db.prepare('SELECT * FROM agent_coordination_claims WHERE agent_id = ?').all('agent-1') as { released_at_epoch: number | null }[];
      expect(allClaims).toHaveLength(2);
      const released = allClaims.filter(c => c.released_at_epoch !== null);
      expect(released).toHaveLength(1);
    });
  });

  // Test 10: Selective cleanup (mix expired + active)
  describe('selective cleanup', () => {
    it('should only clean up expired claims, leaving active ones', () => {
      // Active claim
      claimFiles(db, {
        agent_id: 'agent-active',
        agent_name: 'Active Agent',
        files: ['active.ts'],
        scope: 'write',
        ttl_minutes: 30,
      });

      // Expired claim
      claimFiles(db, {
        agent_id: 'agent-expired',
        agent_name: 'Expired Agent',
        files: ['expired.ts'],
        scope: 'write',
        ttl_minutes: 0,
      });

      // Force the expired one to be in the past
      db.prepare(`
        UPDATE agent_coordination_claims
        SET expires_at_epoch = ?
        WHERE agent_id = 'agent-expired'
      `).run(Date.now() - 1000);

      const cleaned = cleanupExpiredClaims(db);
      expect(cleaned).toBe(1);

      // Active claim still there
      const active = getActiveClaims(db, 'agent-active');
      expect(active).toHaveLength(1);

      // Expired claim is released
      const expired = getActiveClaims(db, 'agent-expired');
      expect(expired).toHaveLength(0);
    });
  });

  // Test: checkConflicts with exclude_agent_id
  describe('checkConflicts', () => {
    it('should check conflicts and exclude specified agent', () => {
      claimFiles(db, {
        agent_id: 'agent-a',
        agent_name: 'Agent A',
        files: ['shared.ts'],
        scope: 'write',
        ttl_minutes: 30,
      });

      // Check from agent-b's perspective
      const result = checkConflicts(db, ['shared.ts'], 'agent-a');
      expect(result.conflicts[0].has_conflict).toBe(false);

      // Check without exclusion
      const result2 = checkConflicts(db, ['shared.ts']);
      expect(result2.conflicts[0].has_conflict).toBe(true);
      expect(result2.conflicts[0].claims).toHaveLength(1);
    });
  });
});
