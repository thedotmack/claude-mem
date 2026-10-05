import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const installer = readFileSync(join(root, 'openclaw/install.sh'), 'utf8');
const launcher = installer.slice(installer.indexOf('start_worker() {'), installer.indexOf('\nverify_health() {'));
const copyStart = installer.indexOf('copy_runtime_settings() {');
const upgradeStart = installer.indexOf('  if [[ "$UPGRADE_MODE" == "true" ]] && is_claude_mem_installed; then');
const upgrade = installer.slice(upgradeStart, installer.indexOf('  configure_memory_slot', upgradeStart));
const copier = copyStart < 0 ? '' : installer.slice(copyStart, installer.indexOf('\ninstall_plugin() {', copyStart));

// Run the production shell launcher, not the full installer. Its only worker is
// an owned Bun script that emits stdout and uses the real Logger, then exits.
// No ports, installed plugin, user settings, or user database are touched.
describe('OpenClaw worker log directory', () => {
  for (const kind of ['environment', 'flat BOM settings', 'nested settings', 'default']) {
    it(`launches and reads stdout with ${kind}`, () => {
      const home = mkdtempSync(join(tmpdir(), 'cm-openclaw-logs-'));
      try {
        const extension = join(home, 'bundled-only');
        const data = kind === 'default' ? join(home, '.claude-mem') : join(home, 'custom data');
        const scripts = join(extension, 'plugin/scripts');
        mkdirSync(scripts, { recursive: true });
        mkdirSync(join(home, '.claude-mem'), { recursive: true });
        // Simulate the installed standalone tree: no src directory exists.
        copyFileSync(join(root, 'src/shared/runtime-settings.cjs'), join(scripts, 'runtime-settings.cjs'));
        writeFileSync(join(scripts, 'worker-service.cjs'), `const { logger } = require(${JSON.stringify(join(root, 'src/utils/logger.ts'))});\nlogger.info('SYSTEM', 'native Logger marker');\nconsole.log('owned launcher marker');\n`);
        if (kind === 'flat BOM settings') writeFileSync(join(home, '.claude-mem/settings.json'), '\uFEFF' + JSON.stringify({ CLAUDE_MEM_DATA_DIR: '~/custom data' }));
        if (kind === 'nested settings') writeFileSync(join(home, '.claude-mem/settings.json'), JSON.stringify({ CLAUDE_MEM_DATA_DIR: join(home, 'stale'), env: { CLAUDE_MEM_DATA_DIR: '~/custom data' } }));
        const env = { ...process.env, HOME: home, USERPROFILE: home, TZ: 'UTC', CLAUDE_MEM_DATA_DIR: kind === 'environment' ? '~/custom data' : '', TEST_EXTENSION: extension, BUN_PATH: process.execPath };
        const launched = spawnSync('bash', ['-c', `set -eu\ninfo() { :; }\nsuccess() { :; }\nerror() { printf '%s\\n' "$*" >&2; }\nfind_claude_mem_install_dir() { CLAUDE_MEM_INSTALL_DIR="$TEST_EXTENSION"; }\n${launcher}\nstart_worker\nwait "$WORKER_PID"\n`], { env, encoding: 'utf8' });
        expect(launched.status).toBe(0);
        const read = spawnSync('node', [join(root, 'scripts/worker-logs.cjs')], { env, encoding: 'utf8' });
        expect(read.status).toBe(0);
        expect(read.stdout).toContain('owned launcher marker');
        const utc = new Date().toISOString().slice(0, 10);
        expect(readFileSync(join(data, 'logs', `claude-mem-${utc}.log`), 'utf8')).toContain('native Logger marker');
        if (kind !== 'default') expect(existsSync(join(home, '.claude-mem/logs'))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }


  for (const failed of [false, true]) it('prepares an older standalone upgrade ' + (failed ? 'with atomic delivery failure' : 'before restarting'), () => {
    const home = mkdtempSync(join(tmpdir(), 'cm-openclaw-upgrade-'));
    try {
      const extension = join(home, 'old-extension');
      const scripts = join(extension, 'plugin/scripts');
      mkdirSync(scripts, { recursive: true });
      mkdirSync(join(home, '.claude-mem'), { recursive: true });
      writeFileSync(join(home, '.claude-mem/settings.json'), '\uFEFF' + JSON.stringify({env:{CLAUDE_MEM_DATA_DIR:'~/custom data'}}));
      writeFileSync(join(scripts, 'worker-service.cjs'), `console.log('upgraded owned worker');\n`);
      const body = `set -eu\ninfo() { :; }\nsuccess() { :; }\nerror() { printf '%s\n' "$*" >&2; }\nis_claude_mem_installed() { CLAUDE_MEM_INSTALL_DIR="$TEST_EXTENSION"; }\nfind_claude_mem_install_dir() { CLAUDE_MEM_INSTALL_DIR="$TEST_EXTENSION"; }\ninstall_plugin() { echo 'unexpected reinstall' >&2; exit 9; }\ncurl() {\n  local output=''\n  local url=''\n  while (( $# )); do\n    if [[ "$1" == '-o' ]]; then output="$2"; shift 2; else url="$1"; shift; fi\n  done\n  printf '%s' "$url" > "$TEST_URL"\n  if [[ "$TEST_FAIL" == '1' ]]; then printf 'partial' > "$output"; return 22; fi\n  cp "$TEST_RESOLVER" "$output"\n}\n${copier}\n${launcher}\n${upgrade}\nprintf 'restart reached' > "$TEST_RESTART"\nstart_worker\nwait "$WORKER_PID"\n`;
      const env = {...process.env,HOME:home,USERPROFILE:home,CLAUDE_MEM_DATA_DIR:'',TZ:'UTC',COLOR_BOLD:'',COLOR_RESET:'',UPGRADE_MODE:'true',CLAUDE_MEM_BRANCH:'feature/owned',TEST_EXTENSION:extension,TEST_RESOLVER:join(root,'src/shared/runtime-settings.cjs'),TEST_URL:join(home,'requested-url'),TEST_RESTART:join(home,'restart'),TEST_FAIL:failed?'1':'0',BUN_PATH:process.execPath};
      const result = spawnSync('bash',['-c',body],{env,encoding:'utf8'});
      expect(result.status, result.stderr).toBe(failed ? 1 : 0);
      expect(existsSync(join(home,'restart'))).toBe(!failed);
      const module = join(scripts,'runtime-settings.cjs');
      expect(existsSync(module)).toBe(!failed);
      if (!failed) {
        expect(readFileSync(module,'utf8')).toBe(readFileSync(join(root,'src/shared/runtime-settings.cjs'),'utf8'));
        expect(readFileSync(join(home,'requested-url'),'utf8')).toBe('https://raw.githubusercontent.com/thedotmack/claude-mem/feature/owned/src/shared/runtime-settings.cjs');
        expect(readFileSync(join(home,'custom data/logs',`worker-${new Date().toISOString().slice(0,10)}.log`),'utf8')).toContain('upgraded owned worker');
      }
    } finally { rmSync(home,{recursive:true,force:true}); }
  });

  it('requests an update before launching an older installation without a resolver', () => {
    const home = mkdtempSync(join(tmpdir(), 'cm-openclaw-legacy-'));
    try {
      const result = spawnSync('bash', ['-c', `set -eu\ninfo() { :; }\nsuccess() { :; }\nerror() { printf '%s\\n' "$*" >&2; }\nfind_claude_mem_install_dir() { CLAUDE_MEM_INSTALL_DIR="$TEST_EXTENSION"; }\n${launcher}\nstart_worker\n`], { env: { ...process.env, HOME: home, TEST_EXTENSION: join(home, 'old-extension') }, encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('reinstall or update');
      expect(existsSync(join(home, '.claude-mem/logs'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('copies the canonical resolver into a standalone installation', () => {
    const home = mkdtempSync(join(tmpdir(), 'cm-openclaw-packaging-'));
    try {
      const extension = join(home, 'extension');
      const result = spawnSync('bash', ['-c', `set -eu\n${copier}\ncopy_runtime_settings "$TEST_REPO" "$TEST_EXTENSION"\n`], { env: { ...process.env, TEST_REPO: root, TEST_EXTENSION: extension }, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(readFileSync(join(extension, 'plugin/scripts/runtime-settings.cjs'), 'utf8')).toBe(readFileSync(join(root, 'src/shared/runtime-settings.cjs'), 'utf8'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
