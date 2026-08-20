import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  classifySettingsDocument,
  ensureSettingsDocument,
  migrateSettingsDocumentToFlat,
  updateSettingsDocument,
} from '../../src/shared/settings-document.js';

const tempFile = (value?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-document-'));
  const path = join(dir, 'settings.json');
  if (value !== undefined) writeFileSync(path, value);
  return path;
};

describe('settings document boundary', () => {
  it('classifies flat, nested, mixed, and unrelated env documents', () => {
    expect(classifySettingsDocument({ CLAUDE_MEM_MODEL: 'flat' })).toBe('flat');
    expect(classifySettingsDocument({ env: { CLAUDE_MEM_MODEL: 'nested' } })).toBe('nested');
    expect(classifySettingsDocument({ CLAUDE_MEM_MODEL: 'root', env: { CLAUDE_MEM_MODEL: 'nested' } })).toBe('flat');
    expect(classifySettingsDocument({ env: { PATH: '/bin' }, hooks: [] })).toBe('flat');
  });

  it('refuses invalid existing bytes and never rewrites them', () => {
    const path = tempFile('{"env":');
    const before = readFileSync(path, 'utf8');
    expect(updateSettingsDocument(path, { CLAUDE_MEM_MODEL: 'new' }).status).toBe('refused');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('preserves complete documents and uses explicit missing-file seeds', () => {
    const path = tempFile(JSON.stringify({ env: { CLAUDE_MEM_MODEL: 'old' }, hooks: ['keep'] }));
    expect(updateSettingsDocument(path, { CLAUDE_MEM_MODEL: 'new' }).status).toBe('updated');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ env: { CLAUDE_MEM_MODEL: 'new' }, hooks: ['keep'] });

    const missing = tempFile();
    expect(ensureSettingsDocument(missing, { callerSeed: true }).status).toBe('created');
    expect(JSON.parse(readFileSync(missing, 'utf8'))).toEqual({ callerSeed: true });
  });

  it('composes nested flattening and Telegram migration in one final document', () => {
    const path = tempFile(JSON.stringify({
      env: { CLAUDE_MEM_MODEL: 'old', CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: 'security_alert' },
      hooks: ['keep'],
    }));
    const result = migrateSettingsDocumentToFlat(path, flat => {
      flat.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES = 'security_alert,sensitive';
    });
    expect(result.status).toBe('updated');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      CLAUDE_MEM_MODEL: 'old',
      CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: 'security_alert,sensitive',
      hooks: ['keep'],
    });
  });
});
