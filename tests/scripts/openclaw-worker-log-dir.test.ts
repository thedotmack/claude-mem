import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const installer = readFileSync(join(root, 'openclaw/install.sh'), 'utf8');
const launcher = installer.slice(installer.indexOf('start_worker() {'), installer.indexOf('\nverify_health() {'));
const copyStart = installer.indexOf('copy_runtime_settings() {');
const main = installer.slice(installer.indexOf('main() {'), installer.lastIndexOf('\nmain "$@"'));
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


  for (const kind of ['healthy offline', 'restart', 'failed restart', 'fresh startup', 'fresh standalone install']) {
    it(`upgrades an older standalone installation with ${kind}`, () => {
      const home = mkdtempSync(join(tmpdir(), 'cm-openclaw-upgrade-'));
      try {
        const extension = join(home, 'old-extension');
        const scripts = join(extension, 'plugin/scripts');
        const failed = kind === 'failed restart';
        const healthy = kind === 'healthy offline';
        mkdirSync(scripts, { recursive: true });
        mkdirSync(join(home, '.claude-mem'), { recursive: true });
        writeFileSync(join(extension, 'package.json'), JSON.stringify({version:'2.0.0'}));
        writeFileSync(join(home, '.claude-mem/settings.json'), '\uFEFF' + JSON.stringify({env:{CLAUDE_MEM_DATA_DIR:'~/custom data'}}));
        writeFileSync(join(scripts, 'worker-service.cjs'), `console.log('upgraded owned worker');\n`);
        // Exercise the actual installer main and native launcher in an owned home.
        // Dependency/configuration side effects and HTTP transport alone are stubs.
        const body = `set -eu
info() { :; }
success() { :; }
warn() { :; }
error() { printf '%s\n' "$*" >&2; }
for name in setup_tty print_banner detect_platform check_bun check_uv check_openclaw configure_memory_slot setup_ai_provider setup_observation_feed write_observation_feed_config; do
  eval "$name() { :; }"
done
write_settings() { printf 'updated' > "$TEST_SETTINGS"; }
is_claude_mem_installed() { CLAUDE_MEM_INSTALL_DIR="$TEST_EXTENSION"; }
find_claude_mem_install_dir() { CLAUDE_MEM_INSTALL_DIR="$TEST_EXTENSION"; }
install_plugin() {
  if [[ "$TEST_KIND" != 'fresh standalone install' ]]; then echo 'unexpected reinstall' >&2; exit 9; fi
  copy_runtime_settings "$TEST_REPO" "$TEST_EXTENSION"
}
port_checks=0
check_port_37777() {
  port_checks=$((port_checks+1))
  [[ "$TEST_KIND" != 'fresh startup' && "$TEST_KIND" != 'fresh standalone install' && "$port_checks" == '1' ]]
}
verify_health() { WORKER_VERSION="$TEST_VERSION"; return 0; }
sleep() { :; }
print_completion_summary() {
  if [[ -n "\${WORKER_PID:-}" ]]; then wait "$WORKER_PID"; fi
  printf 'completed' > "$TEST_COMPLETION"
}
curl() {
  if [[ "$*" == *'/api/admin/shutdown'* ]]; then printf 'stopped' > "$TEST_STOP"; return 0; fi
  local output='' url=''
  while (( $# )); do
    if [[ "$1" == '-o' ]]; then output="$2"; shift 2; else url="$1"; shift; fi
  done
  printf '%s' "$url" > "$TEST_URL"
  if [[ "$TEST_OFFLINE" == '1' ]]; then printf 'partial' > "$output"; return 22; fi
  cp "$TEST_RESOLVER" "$output"
}
${copier}
${launcher}
${main}
main
`;
        const env = {...process.env,HOME:home,USERPROFILE:home,CLAUDE_MEM_DATA_DIR:'',TZ:'UTC',COLOR_BOLD:'',COLOR_RESET:'',UPGRADE_MODE:kind === 'fresh standalone install'?'false':'true',CLAUDE_MEM_BRANCH:'feature/owned',PLUGIN_FRESHLY_INSTALLED:'false',WORKER_AI_PROVIDER:'',AI_PROVIDER:'',WORKER_UPTIME:'',WORKER_REPORTED_PID:'',CLAUDE_MEM_INSTALL_DIR:'',TEST_EXTENSION:extension,TEST_REPO:root,TEST_RESOLVER:join(root,'src/shared/runtime-settings.cjs'),TEST_URL:join(home,'requested-url'),TEST_STOP:join(home,'stopped'),TEST_SETTINGS:join(home,'settings-updated'),TEST_COMPLETION:join(home,'completed'),TEST_OFFLINE:failed||healthy?'1':'0',TEST_KIND:kind,TEST_VERSION:healthy?'2.0.0':'1.0.0',BUN_PATH:process.execPath};
        const result = spawnSync('bash',['-c',body],{env,encoding:'utf8'});
        expect(result.status, result.stderr).toBe(failed ? 1 : 0);
        expect(existsSync(join(home,'settings-updated'))).toBe(true);
        expect(existsSync(join(home,'completed'))).toBe(!failed);
        expect(existsSync(join(home,'stopped'))).toBe(kind === 'restart');
        const module = join(scripts,'runtime-settings.cjs');
        expect(existsSync(module)).toBe(!failed && !healthy);
        expect(existsSync(join(home,'requested-url'))).toBe(!healthy && kind !== 'fresh standalone install');
        if (!failed && !healthy) {
          expect(readFileSync(module,'utf8')).toBe(readFileSync(join(root,'src/shared/runtime-settings.cjs'),'utf8'));
          if (kind !== 'fresh standalone install') expect(readFileSync(join(home,'requested-url'),'utf8')).toBe('https://raw.githubusercontent.com/thedotmack/claude-mem/feature/owned/src/shared/runtime-settings.cjs');
          expect(readFileSync(join(home,'custom data/logs',`worker-${new Date().toISOString().slice(0,10)}.log`),'utf8')).toContain('upgraded owned worker');
        }
      } finally { rmSync(home,{recursive:true,force:true}); }
    });
  }

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
