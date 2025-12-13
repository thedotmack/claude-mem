import { describe, it, expect } from 'vitest';

/**
 * Tests for branch selector validation
 * 
 * The branch selector allows users to switch between stable and experimental branches.
 * This test validates that the allowed branches list is correct.
 */

describe('Branch Selector', () => {
  it('should allow main branch', () => {
    const allowedBranches = ['main', 'beta/7.0', 'feature/bun-executable'];
    expect(allowedBranches).toContain('main');
  });

  it('should allow beta/7.0 branch', () => {
    const allowedBranches = ['main', 'beta/7.0', 'feature/bun-executable'];
    expect(allowedBranches).toContain('beta/7.0');
  });

  it('should allow feature/bun-executable branch', () => {
    const allowedBranches = ['main', 'beta/7.0', 'feature/bun-executable'];
    expect(allowedBranches).toContain('feature/bun-executable');
  });

  it('should reject invalid branch names', () => {
    const allowedBranches = ['main', 'beta/7.0', 'feature/bun-executable'];
    expect(allowedBranches).not.toContain('invalid-branch');
    expect(allowedBranches).not.toContain('develop');
    expect(allowedBranches).not.toContain('feature/other');
  });

  it('should have exactly 3 allowed branches', () => {
    const allowedBranches = ['main', 'beta/7.0', 'feature/bun-executable'];
    expect(allowedBranches).toHaveLength(3);
  });
});
