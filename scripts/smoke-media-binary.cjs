const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'win32') throw new Error('Windows executable smoke requires a native Windows runner');
const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const artifacts = path.join(root, 'dist', 'binaries');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cmem-media-binary-'));
try {
  for (const file of [`worker-service-v${version}-win-x64.exe`, 'package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(artifacts, file), path.join(temporary, file));
  }
  const install = spawnSync('npm.cmd', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: temporary, encoding: 'utf8', shell: true, timeout: 180_000,
  });
  if (install.status !== 0) throw new Error(`Native sidecar install failed: ${install.stderr}`);
  const binary = path.join(temporary, `worker-service-v${version}-win-x64.exe`);
  const decoder = path.join(temporary, 'node_modules', 'sharp');
  fs.renameSync(decoder, decoder + '.disabled');
  try {
    const text = spawnSync(binary, ['--version'], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, NODE_PATH: '', CLAUDE_MEM_DATA_DIR: path.join(temporary, 'data'),
        CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false', CLAUDE_MEM_MEDIA_INFERENCE_ENABLED: 'false' } });
    if (text.error || text.status !== 0 || text.stdout.trim() !== version) {
      throw new Error('Flags-off binary failed to print its exact version and exit without Sharp');
    }
    const missing = spawnSync(binary, ['media-smoke'], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, NODE_PATH: '', CLAUDE_MEM_DATA_DIR: path.join(temporary, 'data') } });
    if (missing.error || missing.status !== 1 || missing.stderr.trim() !== '{"mediaRuntime":"failed","code":"decoder_unavailable"}') {
      throw new Error('Missing native sidecar did not fail with bounded JSON and nonzero exit');
    }
  } finally { fs.renameSync(decoder + '.disabled', decoder); }
  const result = spawnSync(binary, ['media-smoke'], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, NODE_PATH: '', CLAUDE_MEM_DATA_DIR: path.join(temporary, 'data') } });
  if (result.error || result.status !== 0 || !result.stdout.includes('"mediaRuntime":"ok"')) {
    throw new Error(`Native binary decoder smoke failed: ${result.stderr || result.stdout}`);
  }
  process.stdout.write(result.stdout);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
