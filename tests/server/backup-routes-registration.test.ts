import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';

describe('BackupRoutes registration', () => {
  it('worker-service.ts imports and registers BackupRoutes', () => {
    const source = readFileSync(
      path.join(import.meta.dir, '../../src/services/worker-service.ts'),
      'utf-8'
    );
    expect(source).toContain("import { BackupRoutes } from './worker/http/routes/BackupRoutes.js';");
    expect(source).toContain('new BackupRoutes(');
  });
});
