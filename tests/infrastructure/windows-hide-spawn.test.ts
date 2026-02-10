/**
 * Tests that all spawn/exec calls include windowsHide: true
 * to prevent visible command prompt windows on Windows.
 *
 * Uses static analysis of source files to verify the option is present.
 * This prevents regressions where new spawn/exec calls are added without
 * the windowsHide option.
 *
 * Fixes #997: VSCode CLI bun command prompt spam on Windows
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';

// import.meta.dir = tests/infrastructure/, so go up two levels to project root
const PROJECT_ROOT = join(dirname(import.meta.dir), '..');

/**
 * Files containing spawn/exec calls that MUST have windowsHide: true.
 * Each entry maps a file path to known exceptions (calls that don't need windowsHide).
 */
const SOURCE_FILES_WITH_SPAWN_CALLS = [
  {
    path: join(PROJECT_ROOT, 'src', 'services', 'infrastructure', 'ProcessManager.ts'),
    // Unix-only spawn in spawnDaemon doesn't need windowsHide (Windows path uses WMIC)
    exceptions: ['spawn(process.execPath, [scriptPath']
  },
  {
    path: join(PROJECT_ROOT, 'src', 'services', 'worker', 'ProcessRegistry.ts'),
    exceptions: []
  },
  {
    path: join(PROJECT_ROOT, 'src', 'services', 'worker', 'SDKAgent.ts'),
    exceptions: []
  },
  {
    path: join(PROJECT_ROOT, 'src', 'services', 'worker', 'BranchManager.ts'),
    exceptions: []
  },
  {
    path: join(PROJECT_ROOT, 'src', 'utils', 'bun-path.ts'),
    exceptions: []
  },
  {
    path: join(PROJECT_ROOT, 'src', 'shared', 'paths.ts'),
    exceptions: []
  },
  {
    path: join(PROJECT_ROOT, 'src', 'cli', 'claude-md-commands.ts'),
    exceptions: []
  },
  {
    path: join(PROJECT_ROOT, 'plugin', 'scripts', 'bun-runner.js'),
    exceptions: []
  },
  {
    path: join(PROJECT_ROOT, 'plugin', 'scripts', 'smart-install.js'),
    exceptions: []
  }
];

/**
 * Files that are explicitly excluded from this check because they only
 * run on macOS (platform-gated) and don't affect Windows users.
 */
const EXCLUDED_FILES = [
  // ChromaSync.ts - execSync calls are inside `if (process.platform !== 'darwin') return`
  // guard, so they only run on macOS for Zscaler cert handling
  'src/services/sync/ChromaSync.ts'
];

/**
 * Extract spawn/exec call blocks from source code.
 * Returns array of { callType, lineNumber, optionsBlock } for each call found.
 */
function extractSpawnExecCalls(content: string): Array<{
  callType: string;
  lineNumber: number;
  fullMatch: string;
  hasWindowsHide: boolean;
}> {
  const results: Array<{
    callType: string;
    lineNumber: number;
    fullMatch: string;
    hasWindowsHide: boolean;
  }> = [];

  const lines = content.split('\n');

  // Match spawn(), spawnSync(), execSync(), exec() calls
  // But skip regex.exec(), string.exec(), etc.
  const callPattern = /\b(spawn|spawnSync|execSync)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = callPattern.exec(line);
    if (!match) continue;

    // Skip lines that are comments
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // Skip import statements
    if (trimmed.startsWith('import ')) continue;

    const callType = match[1];

    // Look ahead up to 15 lines to find the closing of the options object
    let block = '';
    for (let j = i; j < Math.min(i + 15, lines.length); j++) {
      block += lines[j] + '\n';
      // Check if we've found a reasonable end (closing paren with semicolon or just paren)
      if (block.includes('});') || block.includes(');\n') || (j > i && lines[j].trim() === '});')) {
        break;
      }
    }

    const hasWindowsHide = block.includes('windowsHide');

    results.push({
      callType,
      lineNumber: i + 1,
      fullMatch: block.trim().substring(0, 200),
      hasWindowsHide
    });
  }

  return results;
}

describe('Windows windowsHide: true enforcement (#997)', () => {
  for (const sourceFile of SOURCE_FILES_WITH_SPAWN_CALLS) {
    describe(sourceFile.path.replace(PROJECT_ROOT, ''), () => {
      it('should have windowsHide: true on all spawn/exec calls', () => {
        const content = readFileSync(sourceFile.path, 'utf-8');
        const calls = extractSpawnExecCalls(content);

        expect(calls.length).toBeGreaterThan(0);

        for (const call of calls) {
          // Check if this call is an exception
          const isException = sourceFile.exceptions.some(
            exc => call.fullMatch.includes(exc)
          );

          if (isException) continue;

          expect(call.hasWindowsHide).toBe(true);
        }
      });
    });
  }

  it('should have windowsHide: true in bun-runner.js main spawn call', () => {
    const content = readFileSync(
      join(PROJECT_ROOT, 'plugin', 'scripts', 'bun-runner.js'),
      'utf-8'
    );

    // The main spawn call that runs the Bun process
    expect(content).toContain('windowsHide: true');

    // Verify the spawn call specifically has it
    const spawnBlock = content.substring(
      content.indexOf('const child = spawn(bunPath'),
      content.indexOf('child.on(\'error\'')
    );
    expect(spawnBlock).toContain('windowsHide: true');
  });

  it('should have windowsHide: true in bun-runner.js findBun spawnSync', () => {
    const content = readFileSync(
      join(PROJECT_ROOT, 'plugin', 'scripts', 'bun-runner.js'),
      'utf-8'
    );

    // The spawnSync call in findBun()
    const findBunBlock = content.substring(
      content.indexOf('function findBun()'),
      content.indexOf('return null;\n}')
    );
    expect(findBunBlock).toContain('windowsHide: true');
  });

  it('should have windowsHide: true on ProcessManager execAsync calls', () => {
    const content = readFileSync(
      join(PROJECT_ROOT, 'src', 'services', 'infrastructure', 'ProcessManager.ts'),
      'utf-8'
    );

    // All execAsync calls should have windowsHide
    const execAsyncPattern = /execAsync\([^)]+,\s*\{([^}]+)\}/g;
    let match;
    while ((match = execAsyncPattern.exec(content)) !== null) {
      expect(match[1]).toContain('windowsHide: true');
    }
  });
});
