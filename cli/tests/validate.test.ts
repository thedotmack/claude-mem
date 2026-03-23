import { describe, it, expect } from 'bun:test';
import {
  validateSearchQuery,
  validateProjectName,
  validateIds,
  validateLimit,
  validateOffset,
  validateSettingKey,
} from '../src/utils/validate.ts';
import { CLIError, ExitCode } from '../src/errors.ts';

// Helper: assert a validation function throws a CLIError with VALIDATION_ERROR code
function expectValidationError(fn: () => void, messageContains?: string): void {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).code).toBe(ExitCode.VALIDATION_ERROR);
    if (messageContains) {
      expect((err as CLIError).message).toContain(messageContains);
    }
  }
  expect(threw).toBe(true);
}

// ─── validateSearchQuery ───────────────────────────────────────────────────

describe('validateSearchQuery', () => {
  it('throws on empty string', () => {
    expectValidationError(() => validateSearchQuery(''), 'required');
  });

  it('throws on whitespace-only string', () => {
    expectValidationError(() => validateSearchQuery('   '), 'required');
  });

  it('throws when query exceeds 500 characters', () => {
    const longQuery = 'a'.repeat(501);
    expectValidationError(() => validateSearchQuery(longQuery), 'too long');
  });

  it('accepts a query of exactly 500 characters', () => {
    const exactQuery = 'a'.repeat(500);
    expect(() => validateSearchQuery(exactQuery)).not.toThrow();
  });

  it('throws on null byte control character', () => {
    expectValidationError(() => validateSearchQuery('hello\x00world'), 'control');
  });

  it('throws on form-feed control character (\\x0c)', () => {
    expectValidationError(() => validateSearchQuery('test\x0cvalue'), 'control');
  });

  it('throws on \\x1f control character', () => {
    expectValidationError(() => validateSearchQuery('abc\x1fdef'), 'control');
  });

  it('allows tab and newline — not in the blocked control char set', () => {
    // 0x09 (tab) and 0x0a (newline) are not matched by /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/
    expect(() => validateSearchQuery('line1\nline2')).not.toThrow();
    expect(() => validateSearchQuery('col1\tcol2')).not.toThrow();
  });

  it('accepts a normal search query', () => {
    expect(() => validateSearchQuery('how does authentication work')).not.toThrow();
  });

  it('accepts query with punctuation and symbols', () => {
    expect(() => validateSearchQuery('rust async/await error handling!')).not.toThrow();
  });
});

// ─── validateProjectName ───────────────────────────────────────────────────

describe('validateProjectName', () => {
  it('throws on path traversal (..)', () => {
    expectValidationError(() => validateProjectName('../etc/passwd'), 'Invalid');
  });

  it('throws on null byte', () => {
    expectValidationError(() => validateProjectName('project\x00name'), 'Invalid');
  });

  it('throws on angle brackets', () => {
    expectValidationError(() => validateProjectName('project<name>'), 'Invalid');
  });

  it('throws on pipe character', () => {
    expectValidationError(() => validateProjectName('proj|ect'), 'Invalid');
  });

  it('throws on question mark', () => {
    expectValidationError(() => validateProjectName('project?'), 'Invalid');
  });

  it('throws on asterisk', () => {
    expectValidationError(() => validateProjectName('project*'), 'Invalid');
  });

  it('throws on double-quote character', () => {
    expectValidationError(() => validateProjectName('project"name'), 'Invalid');
  });

  it('throws when name exceeds 200 characters', () => {
    expectValidationError(() => validateProjectName('p'.repeat(201)), 'too long');
  });

  it('accepts a normal project name with hyphens', () => {
    expect(() => validateProjectName('my-project')).not.toThrow();
  });

  it('accepts a name with forward slash (not in blocked set)', () => {
    expect(() => validateProjectName('org/repo')).not.toThrow();
  });

  it('accepts a name with underscores and numbers', () => {
    expect(() => validateProjectName('project_v2_2026')).not.toThrow();
  });

  it('accepts exactly 200 characters', () => {
    expect(() => validateProjectName('a'.repeat(200))).not.toThrow();
  });
});

// ─── validateIds ──────────────────────────────────────────────────────────

describe('validateIds', () => {
  it('throws on empty array', () => {
    expectValidationError(() => validateIds([]), 'At least one');
  });

  it('throws on non-numeric string', () => {
    expectValidationError(() => validateIds(['abc']), 'Invalid observation ID');
  });

  it('throws on negative number string', () => {
    expectValidationError(() => validateIds(['-1']), 'Invalid observation ID');
  });

  it('throws on zero (IDs must be >= 1)', () => {
    expectValidationError(() => validateIds(['0']), 'Invalid observation ID');
  });

  it('parses floating-point string via parseInt — returns integer part', () => {
    // parseInt('1.5', 10) === 1, which is valid — no throw
    expect(validateIds(['1.5'])).toEqual([1]);
  });

  it('throws if any ID in a mixed list is invalid', () => {
    expectValidationError(() => validateIds(['1', '2', 'bad']), 'Invalid observation ID');
  });

  it('returns parsed numbers for a list of valid IDs', () => {
    expect(validateIds(['1', '42', '100'])).toEqual([1, 42, 100]);
  });

  it('returns single-element array for one valid ID', () => {
    expect(validateIds(['7'])).toEqual([7]);
  });
});

// ─── validateLimit ────────────────────────────────────────────────────────

describe('validateLimit', () => {
  it('returns default 20 when undefined', () => {
    expect(validateLimit(undefined)).toBe(20);
  });

  it('returns default 20 when empty string', () => {
    expect(validateLimit('')).toBe(20);
  });

  it('returns the parsed value when within default max', () => {
    expect(validateLimit('50')).toBe(50);
  });

  it('caps at default max (100) when value exceeds it', () => {
    expect(validateLimit('999')).toBe(100);
  });

  it('caps at a custom max when explicitly provided', () => {
    expect(validateLimit('500', 200)).toBe(200);
  });

  it('accepts value equal to the max (boundary)', () => {
    expect(validateLimit('100')).toBe(100);
  });

  it('throws on non-numeric string', () => {
    expectValidationError(() => validateLimit('abc'), 'positive integer');
  });

  it('throws on zero', () => {
    expectValidationError(() => validateLimit('0'), 'positive integer');
  });

  it('throws on negative number', () => {
    expectValidationError(() => validateLimit('-5'), 'positive integer');
  });
});

// ─── validateOffset ───────────────────────────────────────────────────────

describe('validateOffset', () => {
  it('returns default 0 when undefined', () => {
    expect(validateOffset(undefined)).toBe(0);
  });

  it('returns default 0 when empty string', () => {
    expect(validateOffset('')).toBe(0);
  });

  it('returns the parsed value for a valid positive offset', () => {
    expect(validateOffset('20')).toBe(20);
  });

  it('accepts zero as valid offset', () => {
    expect(validateOffset('0')).toBe(0);
  });

  it('throws on negative number', () => {
    expectValidationError(() => validateOffset('-1'), 'non-negative');
  });

  it('throws on non-numeric string', () => {
    expectValidationError(() => validateOffset('bad'), 'non-negative');
  });
});

// ─── validateSettingKey ───────────────────────────────────────────────────

describe('validateSettingKey', () => {
  it('accepts CLAUDE_MEM_MODEL', () => {
    expect(() => validateSettingKey('CLAUDE_MEM_MODEL')).not.toThrow();
  });

  it('accepts CLAUDE_MEM_WORKER_PORT', () => {
    expect(() => validateSettingKey('CLAUDE_MEM_WORKER_PORT')).not.toThrow();
  });

  it('accepts CLAUDE_MEM_DATA_DIR', () => {
    expect(() => validateSettingKey('CLAUDE_MEM_DATA_DIR')).not.toThrow();
  });

  it('accepts CLAUDE_CODE_PATH', () => {
    expect(() => validateSettingKey('CLAUDE_CODE_PATH')).not.toThrow();
  });

  it('throws on an unknown key', () => {
    expectValidationError(() => validateSettingKey('UNKNOWN_KEY'), 'Unknown setting');
  });

  it('throws on empty string', () => {
    expectValidationError(() => validateSettingKey(''), 'Unknown setting');
  });

  it('throws on lowercase variant of a valid key (case-sensitive)', () => {
    expectValidationError(() => validateSettingKey('claude_mem_model'), 'Unknown setting');
  });

  it('error message includes list of valid keys', () => {
    let message = '';
    try {
      validateSettingKey('BOGUS_KEY');
    } catch (err) {
      message = (err as CLIError).message;
    }
    expect(message).toContain('Valid keys');
  });
});
