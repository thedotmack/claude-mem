import { describe, it, expect, afterAll, mock } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

// e5 migration (plans/2026-07-29-e5-embedding-migration.md, Changes 1-2):
// guards for the vendored chroma-mcp fork and the launcher prefix that
// spawns it. The fork-file assertions are intentionally static (bun cannot
// execute the Python server); they trip if a future vendor refresh drops
// the fork deltas.

import * as realClientSdk from '@modelcontextprotocol/sdk/client/index.js';
import * as realStdioSdk from '@modelcontextprotocol/sdk/client/stdio.js';
import * as realLogger from '../../../src/utils/logger.js';
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realPaths from '../../../src/shared/paths.js';
import * as realEnvSanitizer from '../../../src/supervisor/env-sanitizer.js';
import * as realSupervisor from '../../../src/supervisor/index.ts';

const realClientSdkSnapshot = { ...realClientSdk };
const realStdioSdkSnapshot = { ...realStdioSdk };
const realLoggerSnapshot = { ...realLogger };
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realPathsSnapshot = { ...realPaths };
const realEnvSanitizerSnapshot = { ...realEnvSanitizer };
const realSupervisorSnapshot = { ...realSupervisor };

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {},
}));

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {},
}));

mock.module('../../../src/utils/logger.js', () => ({
  logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, failure: () => {} },
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: { get: () => '', getInt: () => 0, loadFromFile: () => ({}) },
}));

mock.module('../../../src/shared/paths.js', () => ({
  USER_SETTINGS_PATH: '/tmp/fake-settings.json',
  paths: { chroma: () => '/tmp/fake-chroma', combinedCerts: () => '/tmp/fake-certs.pem' },
}));

mock.module('../../../src/supervisor/env-sanitizer.js', () => ({
  sanitizeEnv: (env: NodeJS.ProcessEnv) => env,
}));

mock.module('../../../src/supervisor/index.ts', () => ({
  getSupervisor: () => ({ assertCanSpawn: () => {}, registerProcess: () => {}, unregisterProcess: () => {} }),
}));

import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

type ChromaForkInternals = {
  buildLauncherPrefix: (pythonVersion: string) => string[];
  buildPrewarmCommandArgs: (commandArgs: string[]) => string[];
  resolveVendoredChromaMcpDir: () => string | null;
  getUvxPreflightEnv: () => Record<string, string>;
};

const internals = ChromaMcpManager as unknown as ChromaForkInternals;

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FORK_DIR = path.join(REPO_ROOT, 'vendor', 'chroma-mcp');
const FORK_SERVER_PY = path.join(FORK_DIR, 'src', 'chroma_mcp', 'server.py');
const FORK_PYPROJECT = path.join(FORK_DIR, 'pyproject.toml');

const originalDisableXet = process.env.HF_HUB_DISABLE_XET;

afterAll(() => {
  if (originalDisableXet === undefined) delete process.env.HF_HUB_DISABLE_XET;
  else process.env.HF_HUB_DISABLE_XET = originalDisableXet;
  mock.module('@modelcontextprotocol/sdk/client/index.js', () => realClientSdkSnapshot);
  mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => realStdioSdkSnapshot);
  mock.module('../../../src/utils/logger.js', () => realLoggerSnapshot);
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/paths.js', () => realPathsSnapshot);
  mock.module('../../../src/supervisor/env-sanitizer.js', () => realEnvSanitizerSnapshot);
  mock.module('../../../src/supervisor/index.ts', () => realSupervisorSnapshot);
});

describe('ChromaMcpManager vendored fork resolution', () => {
  it('resolves the vendored fork to an absolute vendor/chroma-mcp dir', () => {
    const dir = internals.resolveVendoredChromaMcpDir();

    expect(dir).not.toBeNull();
    expect(path.isAbsolute(dir!)).toBe(true);
    expect(dir!.endsWith(path.join('vendor', 'chroma-mcp'))).toBe(true);
    expect(fs.existsSync(path.join(dir!, 'pyproject.toml'))).toBe(true);
  });

  it('launcher prefix spawns uvx --from <abs fork path> with all dep overrides', () => {
    const prefix = internals.buildLauncherPrefix('3.13');
    const fromIdx = prefix.indexOf('--from');

    expect(fromIdx).toBeGreaterThan(-1);
    expect(prefix[fromIdx + 1]).toBe(internals.resolveVendoredChromaMcpDir());
    expect(path.isAbsolute(prefix[fromIdx + 1])).toBe(true);
    expect(prefix[fromIdx + 2]).toBe('chroma-mcp');
    expect(prefix.slice(0, fromIdx)).toEqual([
      '--python', '3.13',
      '--with', 'onnxruntime>=1.20',
      '--with', 'protobuf<7',
      '--with', 'sentence-transformers>=4.1.0',
    ]);
  });

  it('prewarm args still slice at the chroma-mcp executable with the fork prefix', () => {
    const commandArgs = [
      ...internals.buildLauncherPrefix('3.13'),
      '--client-type', 'persistent',
      '--data-dir', '/tmp/fake-chroma',
    ];

    const prewarm = internals.buildPrewarmCommandArgs(commandArgs);

    expect(prewarm).toEqual([...internals.buildLauncherPrefix('3.13'), '--help']);
    expect(prewarm).not.toContain('--client-type');
  });
});

describe('ChromaMcpManager spawn env (hf-xet gotcha)', () => {
  it('sets HF_HUB_DISABLE_XET=1 so the e5 model download cannot hang on hf-xet', () => {
    delete process.env.HF_HUB_DISABLE_XET;

    const env = internals.getUvxPreflightEnv();

    expect(env.HF_HUB_DISABLE_XET).toBe('1');
  });

  it('respects an explicit HF_HUB_DISABLE_XET value', () => {
    process.env.HF_HUB_DISABLE_XET = '0';

    const env = internals.getUvxPreflightEnv();

    expect(env.HF_HUB_DISABLE_XET).toBe('0');
  });
});

describe('vendored chroma-mcp fork deltas (static guards)', () => {
  const serverPy = () => fs.readFileSync(FORK_SERVER_PY, 'utf-8');

  it('registers the e5-multilingual embedding function factory', () => {
    const content = serverPy();

    expect(content).toContain('"e5-multilingual"');
    expect(content).toContain('SentenceTransformerEmbeddingFunction(');
    expect(content).toContain('model_name="intfloat/multilingual-e5-small"');
    expect(content).toContain('normalize_embeddings=True');
  });

  it('hardens chroma_add_documents against auto-create (no get_or_create_collection)', () => {
    const content = serverPy();
    const addDocumentsBody = content.slice(content.indexOf('async def chroma_add_documents'));

    // The hardening comment mentions the upstream call by name; assert the
    // actual CALL form is gone instead.
    expect(addDocumentsBody).not.toContain('client.get_or_create_collection(');
    expect(addDocumentsBody).toContain('get_collection(collection_name)');
  });

  it('no longer lists the nonexistent ollama option in the create docstring', () => {
    expect(serverPy()).not.toContain("'ollama'");
  });

  it('declares sentence-transformers as a required dependency', () => {
    const pyproject = fs.readFileSync(FORK_PYPROJECT, 'utf-8');
    const dependenciesBlock = pyproject.slice(
      pyproject.indexOf('dependencies = ['),
      pyproject.indexOf('[project.urls]'),
    );

    expect(dependenciesBlock).toContain('"sentence-transformers>=4.1.0"');
  });
});
