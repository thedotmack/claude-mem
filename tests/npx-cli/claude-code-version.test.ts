import { describe, expect, it } from 'bun:test';
import {
  claudeCodeVersionTooOldWarning,
  MINIMUM_CLAUDE_CODE_VERSION_FOR_EXEC_FORM_HOOKS,
} from '../../src/npx-cli/install/claude-code-version.js';
import { claudeCodeVersionCheck } from '../../src/npx-cli/commands/doctor.js';

// The exec-form hooks (`"command": "claude-mem", "args": [...]`) need Claude
// Code 2.1.139+; an older one runs bare `claude-mem`, which captures nothing.

describe('claudeCodeVersionTooOldWarning', () => {
  it('pins the minimum to 2.1.139', () => {
    expect(MINIMUM_CLAUDE_CODE_VERSION_FOR_EXEC_FORM_HOOKS).toBe('2.1.139');
  });

  it('warns for 2.1.138 with the update command', () => {
    expect(claudeCodeVersionTooOldWarning('2.1.138')).toBe(
      'Claude Code 2.1.138 is older than 2.1.139; claude-mem hooks need 2.1.139+. Update Claude Code: claude update',
    );
  });

  it('warns for an older major or minor', () => {
    expect(claudeCodeVersionTooOldWarning('1.9.999')).not.toBeNull();
    expect(claudeCodeVersionTooOldWarning('2.0.200')).not.toBeNull();
  });

  it('passes 2.1.139 and newer', () => {
    expect(claudeCodeVersionTooOldWarning('2.1.139')).toBeNull();
    expect(claudeCodeVersionTooOldWarning('2.1.140')).toBeNull();
    expect(claudeCodeVersionTooOldWarning('2.2.0')).toBeNull();
    expect(claudeCodeVersionTooOldWarning('3.0.0')).toBeNull();
  });

  it('passes silently when the version is missing or unparseable', () => {
    expect(claudeCodeVersionTooOldWarning(undefined)).toBeNull();
    expect(claudeCodeVersionTooOldWarning('')).toBeNull();
    expect(claudeCodeVersionTooOldWarning('not-a-version')).toBeNull();
    expect(claudeCodeVersionTooOldWarning('2.1')).toBeNull();
  });
});

describe('doctor claudeCodeVersionCheck', () => {
  it('warns below the minimum and is never required', () => {
    const row = claudeCodeVersionCheck('2.1.138');
    expect(row.status).toBe('warn');
    expect(row.required).toBe(false);
    expect(row.detail).toContain('claude update');
  });

  it('passes at or above the minimum', () => {
    expect(claudeCodeVersionCheck('2.1.139').status).toBe('ok');
    expect(claudeCodeVersionCheck('2.2.0').status).toBe('ok');
  });

  it('passes when the version is unknown', () => {
    expect(claudeCodeVersionCheck(undefined).status).toBe('ok');
    expect(claudeCodeVersionCheck('garbage').status).toBe('ok');
  });
});
