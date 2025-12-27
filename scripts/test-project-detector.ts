import { detectCwdFromTool, getProjectFromPath, detectProjectFromTool } from '../src/shared/project-detector.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mem-test-'));
const projectDir = path.join(tmpDir, 'my-cool-project');
const subDir = path.join(projectDir, 'src');
const gitDir = path.join(projectDir, '.git');

console.log(`Setting up test environment in ${tmpDir}`);

// Setup directories
fs.mkdirSync(projectDir);
fs.mkdirSync(subDir);
fs.mkdirSync(gitDir);

// Initialize dummy git repo
execSync('git init', { cwd: projectDir });

let failed = 0;
let passed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`✅ ${message}`);
    passed++;
  } else {
    console.error(`❌ ${message}`);
    failed++;
  }
}

function assertEqual(actual: any, expected: any, message: string) {
  if (actual === expected) {
    console.log(`✅ ${message}`);
    passed++;
  } else {
    console.error(`❌ ${message}: Expected "${expected}", got "${actual}"`);
    failed++;
  }
}

try {
  // Test 1: Bash cd absolute
  console.log('\n--- Testing Bash cd ---');
  const res1 = detectCwdFromTool('Bash', { command: `cd ${projectDir}` }, tmpDir);
  assertEqual(res1, projectDir, 'Bash cd absolute path');

  // Test 2: Bash cd relative
  const res2 = detectCwdFromTool('Bash', { command: 'cd my-cool-project' }, tmpDir);
  assertEqual(res2, projectDir, 'Bash cd relative path');

  // Test 3: File Tool (Read)
  console.log('\n--- Testing File Tools ---');
  const filePath = path.join(subDir, 'index.ts');
  fs.writeFileSync(filePath, 'console.log("hello");');
  const res3 = detectCwdFromTool('Read', { file_path: filePath }, tmpDir);
  assertEqual(res3, subDir, 'Read file absolute path');

  // Test 4: Project Detection (Git)
  console.log('\n--- Testing Project Detection ---');
  const proj1 = getProjectFromPath(subDir);
  assertEqual(proj1, 'my-cool-project', 'Detect project from git root');

  // Test 5: Project Detection (Fallback)
  const nonGitDir = path.join(tmpDir, 'another-project');
  fs.mkdirSync(nonGitDir);
  const proj2 = getProjectFromPath(nonGitDir);
  // Should fallback to directory name
  assertEqual(proj2, 'another-project', 'Detect project from directory name (fallback)');

  // Test 6: Integrated
  console.log('\n--- Testing Integrated detectProjectFromTool ---');
  const context = {
    tool_name: 'Bash',
    tool_input: { command: `cd ${subDir}` },
    cwd: tmpDir
  };
  const proj3 = detectProjectFromTool(context);
  assertEqual(proj3, 'my-cool-project', 'Integrated detection');

} catch (err) {
  console.error('Test failed with exception:', err);
  failed++;
} finally {
  // Cleanup
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    console.error('Failed to cleanup temp dir');
  }
}

console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
