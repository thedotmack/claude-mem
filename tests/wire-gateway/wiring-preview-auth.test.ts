import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DATA_DIR, WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { BUILT_IN_AGENT_DESCRIPTORS } from '../../src/services/wire-gateway/agents/builtin-agents.js';
import type { AgentDescriptor } from '../../src/services/wire-gateway/agents/types.js';
import { runWirePreview } from '../../src/services/wire-gateway/wiring/preview.js';
import { planAgentConnection } from '../../src/services/wire-gateway/wiring/wiring-engine.js';
import { WiringSandbox } from './helpers/wiring-sandbox.js';

const WIRE_GATEWAY_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'services', 'wire-gateway', 'WireGatewayService.ts');
const OPENCODE_CONFIG = '{\n  "provider": {\n    "anthropic": {\n      "options": { "baseURL": "https://api.anthropic.com/v1" }\n    }\n  }\n}\n';
const OAUTH_AUTH = '{"anthropic": {"type": "oauth", "refresh": "r", "access": "a", "expires": 0}}\n';

const sandboxes: WiringSandbox[] = [];
afterEach(() => {
  while (sandboxes.length) sandboxes.pop()!.remove();
});

function sandbox(label: string): WiringSandbox {
  const created = new WiringSandbox(label, { PATH: process.env.PATH });
  sandboxes.push(created);
  return created;
}

function descriptor(id: string): AgentDescriptor {
  return BUILT_IN_AGENT_DESCRIPTORS.find((candidate) => candidate.id === id)!;
}

function previewConnect(box: WiringSandbox) {
  return () => runWirePreview({
    descriptor: descriptor('opencode'),
    disconnect: false,
    environment: box.environment,
    dataDirectory: DATA_DIR,
    wireGatewayDirectory: WIRE_GATEWAY_DIR,
    bunPath: process.execPath,
    scriptPath: WIRE_GATEWAY_SCRIPT,
  });
}

describe('wire preview reads the auth files the real connect reads', () => {
  it('copies OpenCode\'s auth.json (its data folder, not its config folder), so an OAuth provider is refused as the real connect refuses it', () => {
    const box = sandbox('preview-opencode-auth');
    box.write('.config/opencode/opencode.json', OPENCODE_CONFIG);
    box.write('.local/share/opencode/auth.json', OAUTH_AUTH);
    expect(() => planAgentConnection(descriptor('opencode'), box.options())).toThrow(/signed in with OAuth/);
    expect(previewConnect(box)).toThrow(/signed in with OAuth/);
    expect(box.read('.config/opencode/opencode.json')).toBe(OPENCODE_CONFIG);
  }, 60_000);

  it('follows XDG_DATA_HOME, also one outside home', () => {
    const box = sandbox('preview-opencode-xdg');
    box.write('.config/opencode/opencode.json', OPENCODE_CONFIG);
    const outsideHomeDataDirectory = join(box.root, 'xdg-data');
    mkdirSync(join(outsideHomeDataDirectory, 'opencode'), { recursive: true });
    writeFileSync(join(outsideHomeDataDirectory, 'opencode', 'auth.json'), OAUTH_AUTH);
    box.env.XDG_DATA_HOME = outsideHomeDataDirectory;
    expect(() => planAgentConnection(descriptor('opencode'), box.options())).toThrow(/signed in with OAuth/);
    expect(previewConnect(box)).toThrow(/signed in with OAuth/);
  }, 60_000);

  it('an API-key auth.json still previews a connect', () => {
    const box = sandbox('preview-opencode-api');
    box.write('.config/opencode/opencode.json', OPENCODE_CONFIG);
    box.write('.local/share/opencode/auth.json', '{"anthropic": {"type": "api", "key": "sk-ant-api-secret"}}\n');
    const result = previewConnect(box)();
    expect(result.changes.map((change) => change.displayPath)).toEqual(['~/.config/opencode/opencode.json']);
    // auth.json is read, never shown or diffed.
    expect(JSON.stringify(result)).not.toContain('sk-ant-api-secret');
  }, 60_000);
});
