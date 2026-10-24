import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { builtInAgentNames, loadAgentRegistry, requireAgentDescriptor } from '../../src/services/wire-gateway/agents/agent-registry.js';
import { expandUserDescriptorPath, loadUserAgentDescriptors } from '../../src/services/wire-gateway/agents/user-agents.js';
import { connectAgent, disconnectAgent } from '../../src/services/wire-gateway/wiring/wiring-engine.js';
import {
  STASHED_ABSENT,
  readStash,
  requireStashedAgentEntry,
  stashPath,
  updateStash,
} from '../../src/services/wire-gateway/wiring/wiring-records.js';
import { TEST_GATEWAY_ORIGIN, WiringSandbox } from './helpers/wiring-sandbox.js';

const IS_WINDOWS = process.platform === 'win32';
const sandboxes: WiringSandbox[] = [];
afterEach(() => {
  while (sandboxes.length) sandboxes.pop()!.remove();
});

function sandbox(label: string): WiringSandbox {
  const created = new WiringSandbox(label);
  sandboxes.push(created);
  return created;
}

describe('wiring/stash.json', () => {
  it('copies a stash that does not parse aside, never reads it as empty, and the next write starts clean', () => {
    const box = sandbox('stash-bad');
    mkdirSync(box.wiringDirectory, { recursive: true });
    writeFileSync(stashPath(box.wiringDirectory), '{"version":1,"agents":{"codex":{"fil');

    expect(() => requireStashedAgentEntry(box.wiringDirectory, 'codex')).toThrow(/copied to .*stash\.json\.bad-/);
    updateStash(box.wiringDirectory, (agents) => {
      agents.crush = { files: { config: STASHED_ABSENT }, fields: {} };
    });
    const badCopies = readdirSync(box.wiringDirectory).filter((name) => name.startsWith('stash.json.bad-'));
    expect(badCopies.length).toBeGreaterThanOrEqual(1);
    for (const copy of badCopies) expect(readFileSync(join(box.wiringDirectory, copy), 'utf-8')).toBe('{"version":1,"agents":{"codex":{"fil');
    const stash = readStash(box.wiringDirectory);
    expect(stash.kind === 'read' && Object.keys(stash.agents)).toEqual(['crush']);
    if (!IS_WINDOWS) expect(statSync(stashPath(box.wiringDirectory)).mode & 0o777).toBe(0o600);

    // A good stash makes no further copies.
    const copiesBefore = readdirSync(box.wiringDirectory).filter((name) => name.startsWith('stash.json.bad-')).length;
    updateStash(box.wiringDirectory, (agents) => {
      agents.pi = { files: {}, fields: {} };
    });
    expect(readdirSync(box.wiringDirectory).filter((name) => name.startsWith('stash.json.bad-')).length).toBe(copiesBefore);
  });

  it('keeps every change when 40 processes write it at once', async () => {
    const box = sandbox('stash-40');
    mkdirSync(box.wiringDirectory, { recursive: true });
    const moduleUrl = new URL('../../src/services/wire-gateway/wiring/wiring-records.ts', import.meta.url).href;
    const writers = Array.from({ length: 40 }, (_, index) => Bun.spawn({
      cmd: [process.execPath, '-e', `
        const { updateStash } = await import(${JSON.stringify(moduleUrl)});
        updateStash(${JSON.stringify(box.wiringDirectory)}, (agents) => { agents['agent-${index}'] = { files: {}, fields: {} }; });
      `],
      env: { ...process.env },
      stdout: 'ignore',
      stderr: 'pipe',
    }));
    const exitCodes = await Promise.all(writers.map((writer) => writer.exited));
    expect(exitCodes.every((code) => code === 0)).toBe(true);
    const stash = readStash(box.wiringDirectory);
    expect(stash.kind).toBe('read');
    if (stash.kind === 'read') expect(Object.keys(stash.agents).sort()).toEqual(Array.from({ length: 40 }, (_, index) => `agent-${index}`).sort());
  }, 60_000);
});

function writeUserDescriptor(directory: string, fileName: string, descriptor: unknown): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, fileName), JSON.stringify(descriptor));
}

describe('user agent descriptors', () => {
  it('loads a valid descriptor and refuses built-in ids, aliases, bad wildcards and bad JSON', () => {
    const box = sandbox('user-load');
    const directory = join(box.root, 'agents');
    writeUserDescriptor(directory, 'good.json', {
      id: 'my-agent',
      files: [{ key: 'config', path: '~/.my-agent/config.json', format: 'json' }],
      targets: [{ file: 'config', keyPath: 'providers.*.baseUrl', kind: 'baseUrl' }],
    });
    writeUserDescriptor(directory, 'codex.json', {
      id: 'codex',
      files: [{ key: 'config', path: '~/.x.json', format: 'json' }],
      targets: [{ file: 'config', keyPath: 'a', kind: 'baseUrl' }],
    });
    writeUserDescriptor(directory, 'alias.json', {
      id: 'cc',
      files: [{ key: 'config', path: '~/.x.json', format: 'json' }],
      targets: [{ file: 'config', keyPath: 'a', kind: 'baseUrl' }],
    });
    writeUserDescriptor(directory, 'toml-wildcard.json', {
      id: 'toml-agent',
      files: [{ key: 'config', path: '~/.x.toml', format: 'toml' }],
      targets: [{ file: 'config', keyPath: 'providers.*.base_url', kind: 'baseUrl' }],
    });
    writeUserDescriptor(directory, 'unknown-key.json', { id: 'extra', files: [], targets: [], surprise: true });
    writeFileSync(join(directory, 'broken.json'), '{"id": ');

    const loaded = loadUserAgentDescriptors(directory, builtInAgentNames());
    expect(loaded.descriptors.map((descriptor) => descriptor.id)).toEqual(['my-agent']);
    const refusals = loaded.refusals.join('\n');
    expect(refusals).toMatch(/codex\.json: agent id "codex" is a built-in agent's/);
    expect(refusals).toMatch(/alias\.json: agent id "cc" is a built-in agent's/);
    expect(refusals).toMatch(/toml-wildcard\.json: .*"\*" is allowed only in a JSON target/);
    expect(refusals).toMatch(/unknown-key\.json/);
    expect(refusals).toMatch(/broken\.json/);

    const registry = loadAgentRegistry({ userAgentsDirectory: directory });
    expect(requireAgentDescriptor(registry, 'my-agent').targets).toEqual([{ file: 'config', keyPath: 'providers.*.baseUrl', defaultUpstream: undefined }]);
    expect(requireAgentDescriptor(registry, 'CLAUDE').id).toBe('claude-code');
    expect(() => requireAgentDescriptor(registry, 'kilo')).toThrow(/kilo has no wiring descriptor.*wire routes add/s);
    expect(() => requireAgentDescriptor(registry, 'nope')).toThrow(/Unknown agent "nope"/);
  });

  it('expands ~, $VAR and ${VAR}; a candidate naming an unset variable does not apply', () => {
    const environment = { home: '/home/me', env: { AGENT_HOME: '/opt/agent' }, platform: 'linux' as const };
    expect(expandUserDescriptorPath('~/.a/config.json', environment)).toBe('/home/me/.a/config.json');
    expect(expandUserDescriptorPath('$AGENT_HOME/config.json', environment)).toBe('/opt/agent/config.json');
    expect(expandUserDescriptorPath('${HOME}/x', environment)).toBe('/home/me/x');
    expect(expandUserDescriptorPath('$MISSING/config.json', environment)).toBeNull();
  });

  it('connects and disconnects a user TOML descriptor, removing the table connect created', async () => {
    const box = sandbox('user-toml');
    const directory = join(box.root, 'agents');
    writeUserDescriptor(directory, 'toml-agent.json', {
      id: 'toml-agent',
      detect: { dirs: ['~/.toml-agent'] },
      files: [{ key: 'config', path: '$TOML_AGENT_HOME/config.toml', alternates: ['~/.toml-agent/config.toml'], format: 'toml' }],
      targets: [{ file: 'config', keyPath: 'gateway.base_url', kind: 'baseUrl', defaultUpstream: 'https://api.example.com/v1' }],
      identitySwitches: [{ file: 'config', keyPath: 'gateway.session_headers', value: true }],
      authProbe: { file: 'config', keyPath: 'auth.kind', subscriptionWhen: { equals: ['oauth'] } },
    });
    const original = '# toml agent\nmodel = "m"\n\n[auth]\nkind = "api-key"\n';
    box.write('.toml-agent/config.toml', original);
    const descriptor = requireAgentDescriptor(loadAgentRegistry({ userAgentsDirectory: directory }), 'toml-agent');

    await connectAgent(descriptor, box.options());
    const connected = box.read('.toml-agent/config.toml')!;
    expect(connected).toContain('[gateway]');
    expect(connected).toContain(`base_url = "${TEST_GATEWAY_ORIGIN}/r/toml-agent/v1"`);
    // Edited after connect: the exact-bytes path is off, so the table must go field by field.
    box.write('.toml-agent/config.toml', connected.replace('model = "m"', 'model = "n"'));
    await disconnectAgent('toml-agent', box.options());
    expect(box.read('.toml-agent/config.toml')).toBe(original.replace('model = "m"', 'model = "n"'));
  });

  it('a user authProbe refuses a subscription', async () => {
    const box = sandbox('user-probe');
    const directory = join(box.root, 'agents');
    writeUserDescriptor(directory, 'a.json', {
      id: 'probe-agent',
      files: [{ key: 'config', path: '~/.probe/config.json', format: 'json' }],
      targets: [{ file: 'config', keyPath: 'baseUrl', kind: 'baseUrl' }],
      authProbe: { file: 'config', keyPath: 'auth', subscriptionWhen: { notEquals: ['api-key'] } },
    });
    box.write('.probe/config.json', '{"baseUrl":"https://x.example.com/v1","auth":"login"}');
    const descriptor = requireAgentDescriptor(loadAgentRegistry({ userAgentsDirectory: directory }), 'probe-agent');
    await expect(connectAgent(descriptor, box.options())).rejects.toThrow(/auth is "login", not one of "api-key"/);
  });
});
