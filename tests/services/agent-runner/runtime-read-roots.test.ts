import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { runtimeReadRoots } from '../../../src/services/agent-runner/runtime-read-roots.js';

function fixture(run: (root: string, file: (path: string, text?: string) => void) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-runtime-roots-')));
  const file = (path: string, text = '') => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  try { run(root, file); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('Codex runtime read roots', () => {
  it('keeps native installs scoped to executable directories', () => fixture((root, file) => {
    const binary = join(root, 'native', 'bin', 'codex'); file(binary);
    expect(runtimeReadRoots(binary)).toEqual([dirname(binary)]);
  }));
  it('resolves the official npm optional platform package without opening adjacent packages or home', () => fixture((root, file) => {
    const pkg = join(root, 'node_modules', '@openai', 'codex');
    const wrapper = join(pkg, 'bin', 'codex.js'); file(wrapper, '#!/usr/bin/env node');
    file(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    const native = join(root, 'node_modules', '@openai', 'codex-darwin-arm64');
    file(join(native, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    const runtime = join(native, 'vendor', 'aarch64-apple-darwin'); file(join(runtime, 'bin', 'codex'));
    const command = join(root, 'bin', 'codex'); mkdirSync(dirname(command), { recursive: true }); symlinkSync(wrapper, command);
    const roots = runtimeReadRoots(command, 'darwin', 'arm64');
    expect(roots).toEqual([dirname(command), dirname(wrapper), runtime]);
    expect(roots).not.toContain(root); expect(roots).not.toContain(join(root, 'node_modules'));
  }));
  it('supports the bundled vendor fallback and refuses missing native executables', () => fixture((root, file) => {
    const pkg = join(root, 'node_modules', '@openai', 'codex');
    const wrapper = join(pkg, 'bin', 'codex.js'); file(wrapper);
    file(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    expect(runtimeReadRoots(wrapper, 'linux', 'x64')).toEqual([dirname(wrapper)]);
    const runtime = join(pkg, 'vendor', 'x86_64-unknown-linux-musl'); file(join(runtime, 'bin', 'codex'));
    expect(runtimeReadRoots(wrapper, 'linux', 'x64')).toEqual([dirname(wrapper), runtime]);
  }));
});
