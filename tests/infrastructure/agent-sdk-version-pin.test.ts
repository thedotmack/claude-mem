import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
const installedSdkPackagePath = fileURLToPath(
  new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url),
);

describe('Claude Agent SDK build pin', () => {
  it('declares and resolves exact version 0.3.202', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const installedSdkPackage = JSON.parse(readFileSync(installedSdkPackagePath, 'utf8'));

    expect(packageJson.devDependencies['@anthropic-ai/claude-agent-sdk']).toBe('0.3.202');
    expect(installedSdkPackage.version).toBe('0.3.202');
  });
});
