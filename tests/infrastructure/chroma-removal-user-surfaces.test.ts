import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWorkerDependencyPreflight } from '../../src/services/worker/dependency-preflight.js';
import { resetDependencyStatusesForTesting } from '../../src/shared/dependency-health.js';
import { adoptMergedWorktrees } from '../../src/services/infrastructure/WorktreeAdoption.js';

const REPO_ROOT = join(import.meta.dir, '..', '..');

function readSource(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf-8');
}

function classifier(error: unknown): { kind: string; message: string } {
  return {
    kind: 'transient',
    message: error instanceof Error ? error.message : String(error),
  };
}

describe('user-facing surfaces after the Chroma/uvx removal', () => {
  beforeEach(() => {
    resetDependencyStatusesForTesting();
  });

  it('worker dependency preflight never reports a missing uvx/vector-search dependency', () => {
    const snapshot = runWorkerDependencyPreflight({
      settings: { CLAUDE_MEM_PROVIDER: 'gemini' },
      classifyClaudeError: classifier,
      findClaudeExecutable: () => {
        throw new Error('Claude should not be checked for Gemini');
      },
    });

    expect(snapshot.statuses.map(status => String(status.dependency))).not.toContain('uvx');
    expect(snapshot.statuses.map(status => String(status.kind))).not.toContain('vector_search_unavailable');
    expect(snapshot.degraded).toBe(false);
  });

  it('`claude-mem status` has no uvx/Chroma dependency labels left to print', () => {
    const source = readSource('src/services/worker-service.ts');
    expect(source).not.toContain('uvx unavailable for vector search');
    expect(source).not.toContain('Chroma unavailable for vector search');
  });

  it('`claude-mem doctor` no longer probes uv on behalf of vector search', () => {
    const source = readSource('src/npx-cli/commands/doctor.ts');
    expect(source).not.toContain('vector search');
    expect(source).not.toContain('getUvVersion');
  });

  it('install and repair no longer download or probe uv', () => {
    expect(readSource('src/npx-cli/commands/install.ts')).not.toContain('ensureUv');
    const runtime = readSource('src/npx-cli/install/setup-runtime.ts');
    expect(runtime).not.toContain('astral.sh/uv');
    expect(runtime).not.toContain('export async function ensureUv');
  });

  it('the OpenClaw installer and Docker image no longer install uv', () => {
    const installer = readSource('openclaw/install.sh');
    expect(installer).not.toContain('astral.sh/uv');
    expect(installer).not.toContain('install_uv');
    expect(readSource('docker/claude-mem/Dockerfile')).not.toContain('astral.sh/uv');
  });

  it('the viewer log console can show the components that replaced Chroma', () => {
    const source = readSource('src/ui/viewer/components/LogsModal.tsx');
    // The vector stack logs under VECTOR_INDEX / VECTOR_SYNC. LogsModal drops
    // any line whose component is not an enabled chip, so a missing chip makes
    // those lines invisible rather than merely unfilterable.
    expect(source).toContain("key: 'VECTOR_INDEX'");
    expect(source).toContain("key: 'VECTOR_SYNC'");
  });

  it('worktree adoption no longer carries counters that can only be zero', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'claude-mem-adoption-'));
    const result = await adoptMergedWorktrees({ repoPath: scratch, dataDirectory: scratch });

    expect(Object.keys(result)).not.toContain('chromaUpdates');
    expect(Object.keys(result)).not.toContain('chromaFailed');

    const source = readSource('src/services/worker-service.ts');
    expect(source).not.toContain('Chroma docs updated');
    expect(source).not.toContain('Chroma sync failures');
  });
});
