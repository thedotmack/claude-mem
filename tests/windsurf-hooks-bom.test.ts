import { describe, it, expect, afterAll } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseJsonWithBom } from '../src/shared/atomic-json.js';
import { WIRE_GATEWAY_DIR } from '../src/shared/paths.js';
import { windsurfHookItems, windsurfHooksPath } from '../src/services/wire-gateway/library/agent-library-targets.js';
import { applyLibrary, removeLibrary } from '../src/services/wire-gateway/library/library-engine.js';

// The installer writes to a fixed path under the real home directory, so a
// filesystem test of the installer itself would touch the developer's own
// Windsurf config. Its hooks.json goes through the Library, so this runs the
// Library on Windsurf's items against a sandboxed home instead.
const SOURCE = readFileSync(join(import.meta.dir, '../src/services/integrations/WindsurfHooksInstaller.ts'), 'utf8');
const home = join(WIRE_GATEWAY_DIR, 'tmp', `windsurf-bom-${process.pid}`);
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("Windsurf's hooks.json with a byte order mark", () => {
  it('is never read or written by the installer itself (only through the Library)', () => {
    expect(SOURCE).not.toMatch(/writeFileSync\(\s*WINDSURF_HOOKS_JSON_PATH/);
    expect(SOURCE).not.toMatch(/JSON\.parse\(\s*readFileSync\(\s*WINDSURF_HOOKS_JSON_PATH/);
  });

  it('is edited in place, keeping its BOM and the user\'s hooks, and given back on remove', () => {
    const environment = { home, env: {}, platform: 'linux' as const, cwd: home, bunPath: '/bun', workerServicePath: '/w/worker-service.cjs', mcpServerPath: null, nodePath: '/node' };
    const hooksPath = windsurfHooksPath(environment);
    mkdirSync(join(home, '.codeium', 'windsurf'), { recursive: true });
    const original = '﻿' + JSON.stringify({ hooks: { post_write_code: [{ command: './mine.sh', show_output: true }] } });
    writeFileSync(hooksPath, original);
    const context = { libraryDirectory: join(home, 'library') };
    const { items, jsonStyles } = windsurfHookItems(environment);

    applyLibrary({ agentId: 'windsurf', items, ownedGroups: ['hooks'], jsonStyles }, context);
    const written = readFileSync(hooksPath, 'utf8');
    expect(written.startsWith('﻿')).toBe(true);
    const config = parseJsonWithBom<{ hooks: Record<string, Array<{ command: string }>> }>(written);
    expect(config.hooks.post_write_code.map((hook) => hook.command)).toEqual(['./mine.sh', '"/bun" "/w/worker-service.cjs" hook windsurf file-edit']);

    removeLibrary({ agentId: 'windsurf', items, jsonStyles }, context);
    expect(readFileSync(hooksPath, 'utf8')).toBe(original);
  });
});
