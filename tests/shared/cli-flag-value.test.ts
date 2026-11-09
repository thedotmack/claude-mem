import { describe, expect, it } from 'bun:test';
import { cliFlagValue } from '../../src/shared/cli-flag-value.js';

// Used by `adopt --branch/--cwd` and `memory ingest --source/--cwd`.
describe('cliFlagValue', () => {
  it('reads --name <value> and --name=<value> alike, first occurrence wins', () => {
    expect(cliFlagValue(['adopt', '--branch', 'feature/x'], '--branch')).toBe('feature/x');
    expect(cliFlagValue(['adopt', '--branch=feature/x'], '--branch')).toBe('feature/x');
    expect(cliFlagValue(['--cwd', '/a', '--cwd=/b'], '--cwd')).toBe('/a');
    expect(cliFlagValue(['--source=a=b'], '--source')).toBe('a=b');
  });

  it('is undefined when absent and null when present without a value', () => {
    expect(cliFlagValue(['adopt', '--dry-run'], '--branch')).toBeUndefined();
    expect(cliFlagValue(['--branchy=x'], '--branch')).toBeUndefined();
    expect(cliFlagValue(['--branch'], '--branch')).toBeNull();
    expect(cliFlagValue(['--branch', '--dry-run'], '--branch')).toBeNull();
    expect(cliFlagValue(['--branch='], '--branch')).toBeNull();
    expect(cliFlagValue(['--branch', ''], '--branch')).toBeNull();
  });
});
