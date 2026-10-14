// The worker's data-directory rule (resolveDataDir in src/shared/paths.ts) for
// standalone Node scripts such as worker-logs.cjs, which run without a build.
//
// This is a deliberate second copy. TypeScript modules must not import it:
// bundling a CommonJS module into an ESM bundle makes esbuild emit a `require`
// shim that throws "Dynamic require of fs is not supported" at load.
// tests/scripts/resolve-data-dir-parity.test.ts runs both copies against every
// settings shape the worker accepts, so they cannot drift apart.
const { existsSync, readFileSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');

function expandHome(filePath, platform = process.platform, home = homedir()) {
  if (typeof filePath !== 'string' || filePath.length === 0) return filePath;
  if (filePath === '~') return home;
  if (filePath.startsWith('~/') || (platform === 'win32' && filePath.startsWith('~\\'))) {
    return join(home, filePath.slice(2));
  }
  return filePath;
}

function classifySettingsDocument(document) {
  const env = document.env;
  return env !== null && typeof env === 'object' && !Array.isArray(env)
    && Object.keys(env).some(key => key.startsWith('CLAUDE_MEM_')) ? 'nested' : 'flat';
}

function settingsTarget(document) {
  return classifySettingsDocument(document) === 'nested' ? document.env : document;
}

function stripUtf8Bom(raw) {
  return raw.replace(/^\uFEFF/, '');
}

function parseJsonWithBom(raw) {
  return JSON.parse(stripUtf8Bom(raw));
}

function readJsonFileWithBom(filepath) {
  return parseJsonWithBom(readFileSync(filepath, 'utf-8'));
}

function resolveDataDir() {
  if (process.env.CLAUDE_MEM_DATA_DIR) {
    return expandHome(process.env.CLAUDE_MEM_DATA_DIR);
  }
  const defaultDataDir = join(homedir(), '.claude-mem');
  const settingsPath = join(defaultDataDir, 'settings.json');
  try {
    if (existsSync(settingsPath)) {
      const raw = readJsonFileWithBom(settingsPath);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return defaultDataDir;
      const settings = settingsTarget(raw);
      if (typeof settings.CLAUDE_MEM_DATA_DIR === 'string' && settings.CLAUDE_MEM_DATA_DIR) {
        return expandHome(settings.CLAUDE_MEM_DATA_DIR);
      }
    }
  } catch {
    // A missing or corrupt settings file retains the default data directory.
  }
  return defaultDataDir;
}

module.exports = { resolveDataDir, settingsTarget };
