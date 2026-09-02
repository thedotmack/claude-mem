import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';

const source = readFileSync(
  path.join(__dirname, '..', '..', '..', '..', 'src', 'services', 'worker', 'http', 'routes', 'MemoryRoutes.ts'),
  'utf-8',
);
const sessionStoreSource = readFileSync(
  path.join(__dirname, '..', '..', '..', '..', 'src', 'services', 'sqlite', 'SessionStore.ts'),
  'utf-8',
);

describe('MemoryRoutes — POST /api/memory/save (#2116)', () => {
  it('reads metadata.platformSource from the request body', () => {
    expect(source).toContain("const metadataPlatformSource = typeof metadata?.platformSource === 'string'");
  });

  it('passes platformSource into manual session creation', () => {
    expect(source).toContain('sessionStore.getOrCreateManualSession(targetProject, metadataPlatformSource)');
  });

  it('updates reused manual sessions to the requested platform source', () => {
    expect(sessionStoreSource).toContain("UPDATE sdk_sessions SET platform_source = ? WHERE memory_session_id = ?");
  });
});
