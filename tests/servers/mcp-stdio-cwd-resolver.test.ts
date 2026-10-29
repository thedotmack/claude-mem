import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStdioCwdResolver, MAX_MCP_ROOTS_ATTEMPTS, type StdioRootsPeer } from '../../src/servers/mcp-project-cwd.js';

// The stdio half of the MCP project resolver (#5105, plan-23 Round 5). A fake
// peer stands in for the MCP Server so each roots/list answer, failure and
// overlap is under the test's control.
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-stdio-cwd-')));
afterEach(() => rmSync(temp, { recursive: true, force: true }));

function directory(name: string): string {
  const path = join(temp, name);
  mkdirSync(path, { recursive: true });
  return path;
}

type Answer = () => Promise<{ roots: Array<{ uri: string }> }>;

function peer(options: { roots: boolean; answers?: Answer[] }): StdioRootsPeer & { listRootsCalls: number } {
  const answers = [...(options.answers ?? [])];
  const fake = {
    listRootsCalls: 0,
    getClientCapabilities: () => (options.roots ? { roots: { listChanged: true } } : {}),
    listRoots: async () => {
      fake.listRootsCalls++;
      const next = answers.shift();
      if (!next) throw new Error('fixture: no roots answer queued');
      return next();
    },
  };
  return fake;
}

const answerWith = (path: string): Answer => async () => ({ roots: [{ uri: pathToFileURL(path).href }] });
const timeOut: Answer = async () => { throw new Error('Request timed out'); };

describe('createStdioCwdResolver', () => {
  it('a client without the roots capability gets no roots/list round-trip and the process cwd, like main', async () => {
    const launch = directory('project');
    const fake = peer({ roots: false });
    const resolver = createStdioCwdResolver({ peer: fake, pluginRoot: directory('plugin'), processCwd: () => launch, pwd: () => undefined });

    expect(await resolver.resolve()).toBe(launch);
    expect(await resolver.resolve()).toBe(launch);
    expect(fake.listRootsCalls).toBe(0);
  });

  it('keeps the last good roots answer when a later refresh times out', async () => {
    const pluginRoot = directory('plugin');
    const launch = directory('plugin/scripts');
    const project = directory('project');
    const fake = peer({ roots: true, answers: [answerWith(project), timeOut] });
    const resolver = createStdioCwdResolver({ peer: fake, pluginRoot, processCwd: () => launch, pwd: () => directory('elsewhere') });

    expect(await resolver.resolve()).toBe(project);
    resolver.markRootsStale(); // notifications/roots/list_changed
    expect(await resolver.resolve()).toBe(project);
    expect(fake.listRootsCalls).toBe(2);
  });

  it('refreshes roots again when the project changes during an in-flight lookup', async () => {
    const previousProject = directory('previous-project');
    const currentProject = directory('current-project');
    let releaseStale!: () => void;
    const staleGate = new Promise<void>(resolve => { releaseStale = resolve; });
    const staleAnswer: Answer = async () => {
      await staleGate;
      return { roots: [{ uri: pathToFileURL(previousProject).href }] };
    };
    const fake = peer({ roots: true, answers: [answerWith(previousProject), staleAnswer, answerWith(currentProject)] });
    const resolver = createStdioCwdResolver({
      peer: fake,
      pluginRoot: directory('plugin'),
      processCwd: () => directory('launch'),
      pwd: () => undefined,
    });

    expect(await resolver.resolve()).toBe(previousProject);
    resolver.markRootsStale();
    const pending = resolver.resolve();
    expect(fake.listRootsCalls).toBe(2);

    resolver.markRootsStale();
    releaseStale();
    expect(await pending).toBe(currentProject);
    expect(fake.listRootsCalls).toBe(3);
  });

  it('overlapping calls share one roots/list request instead of each using up an attempt', async () => {
    const project = directory('project');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: Answer = async () => { await gate; return { roots: [{ uri: pathToFileURL(project).href }] }; };
    const fake = peer({ roots: true, answers: [slow] });
    const resolver = createStdioCwdResolver({ peer: fake, pluginRoot: directory('plugin'), processCwd: () => directory('launch'), pwd: () => undefined });

    const pending = Array.from({ length: MAX_MCP_ROOTS_ATTEMPTS + 1 }, () => resolver.resolve());
    release();
    expect(await Promise.all(pending)).toEqual(Array(MAX_MCP_ROOTS_ATTEMPTS + 1).fill(project));
    expect(fake.listRootsCalls).toBe(1);
  });

  it('stops asking after the attempt cap and settles on the fallback until roots change', async () => {
    const launch = directory('launch');
    const project = directory('project');
    const fake = peer({ roots: true, answers: [timeOut, timeOut, timeOut, answerWith(project)] });
    const resolver = createStdioCwdResolver({ peer: fake, pluginRoot: directory('plugin'), processCwd: () => launch, pwd: () => undefined });

    for (let call = 0; call < MAX_MCP_ROOTS_ATTEMPTS + 2; call++) expect(await resolver.resolve()).toBe(launch);
    expect(fake.listRootsCalls).toBe(MAX_MCP_ROOTS_ATTEMPTS);
    resolver.markRootsStale();
    expect(await resolver.resolve()).toBe(project);
  });
});
