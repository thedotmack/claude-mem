import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectObservedBilling } from '../../src/shared/observed-billing.js';

test('recognizes a BOM-prefixed subscription account file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'billing-bom-'));
  try {
    const file = join(dir, '.claude.json');
    writeFileSync(file, '\ufeff' + JSON.stringify({ oauthAccount: { organizationType: 'claude_max' } }));
    expect(detectObservedBilling({}, file)).toBe('max');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
