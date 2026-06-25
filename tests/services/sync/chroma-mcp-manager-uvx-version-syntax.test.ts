import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';

// Regression tests for #2939: chroma-mcp must be pinned with uvx's canonical
// `tool@version` exact-pin form, NOT `tool==version`. `==` in the uvx command
// position is undocumented and was reported to fail on Windows/uvx 0.11.19 with
// "Not a valid package or extra name", killing the MCP connection and degrading
// semantic search to FTS5. `@` is the documented, exact-only form.
//
// These assert the spawned uvx args (captured from the fake transport), i.e.
// the observable behavior of buildCommandArgs() — not any private constant —
// so they survive refactors of how the spec string is composed.

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these mocks do not leak into later
// test files (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realPaths from '../../../src/shared/paths.js';
import * as realLogger from '../../../src/utils/logger.js';
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realPathsSnapshot = { ...realPaths };
const realLoggerSnapshot = { ...realLogger };

let currentSettings: Record<string, string> = {};

let capturedTransportOpts: { command: string; args: string[] } | null = null;

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class FakeTransport {
    onclose: (() => void) | null = null;
    constructor(opts: { command: string; args: string[] }) {
      capturedTransportOpts = { command: opts.command, args: opts.args };
    }
    async close() {}
  },
}));

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class FakeClient {
    constructor() {}
    async connect() {}
    async callTool() {
      return { content: [{ type: 'text', text: '{}' }] };
    }
    async close() {}
  },
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => currentSettings[key] ?? '',
    getInt: () => 0,
    loadFromFile: () => currentSettings,
  },
}));

mock.module('../../../src/shared/paths.js', () => ({
  USER_SETTINGS_PATH: '/tmp/fake-settings.json',
}));

mock.module('../../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
  },
}));

import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

afterAll(() => {
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/paths.js', () => realPathsSnapshot);
  mock.module('../../../src/utils/logger.js', () => realLoggerSnapshot);
});

// The chroma-mcp dist name == its entry-point name, and 0.2.6 is an exact pin,
// so the canonical uvx form is `chroma-mcp@0.2.6`. This must match the pinned
// version constant in ChromaMcpManager.ts (CHROMA_MCP_PINNED_VERSION = '0.2.6').
const EXPECTED_TOOL_SPEC = 'chroma-mcp@0.2.6';

let mgr: ChromaMcpManager;

async function captureArgs(mode: 'local' | 'remote'): Promise<string[]> {
  currentSettings = { CLAUDE_MEM_CHROMA_MODE: mode };
  await mgr.callTool('chroma_list_collections', {});
  expect(capturedTransportOpts).not.toBeNull();
  return capturedTransportOpts!.args;
}

describe('ChromaMcpManager uvx version-pin syntax (#2939)', () => {
  beforeEach(async () => {
    await ChromaMcpManager.reset();
    capturedTransportOpts = null;
    currentSettings = {};
    mgr = ChromaMcpManager.getInstance();
  });

  for (const mode of ['local', 'remote'] as const) {
    // Negative: the exact bug — `chroma-mcp==0.2.6` must never be emitted.
    it(`[${mode}] does not emit the pip-style chroma-mcp==<version> spec`, async () => {
      const args = await captureArgs(mode);
      expect(args).not.toContain('chroma-mcp==0.2.6');
    });

    // Negative (broader guard): no arg in the command line may use `==` pinning
    // for chroma-mcp, regardless of the version value.
    it(`[${mode}] no argument pins chroma-mcp with == syntax`, async () => {
      const args = await captureArgs(mode);
      expect(args.some(a => a.startsWith('chroma-mcp=='))).toBe(false);
    });

    // Positive: the canonical `@` exact-pin spec is emitted...
    it(`[${mode}] emits the canonical chroma-mcp@<version> spec`, async () => {
      const args = await captureArgs(mode);
      expect(args).toContain(EXPECTED_TOOL_SPEC);
    });

    // Positive: ...in the uvx command position (immediately before the
    // --client-type flag that follows it in both modes).
    it(`[${mode}] places the chroma-mcp@<version> spec in the command position`, async () => {
      const args = await captureArgs(mode);
      const clientTypeIdx = args.indexOf('--client-type');
      expect(clientTypeIdx).toBeGreaterThan(0);
      expect(args[clientTypeIdx - 1]).toBe(EXPECTED_TOOL_SPEC);
    });
  }

  // Positive: the pin is still exact (version unchanged) — `@` is exact-only,
  // so this is semantically identical to the prior `==0.2.6`.
  it('preserves the exact 0.2.6 pin via the @ form', async () => {
    const args = await captureArgs('local');
    const spec = args.find(a => a.startsWith('chroma-mcp@'));
    expect(spec).toBe('chroma-mcp@0.2.6');
  });
});
