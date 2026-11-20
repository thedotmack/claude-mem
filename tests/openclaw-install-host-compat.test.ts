import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

const INSTALL_SH = readFileSync(path.join(import.meta.dir, '..', 'openclaw', 'install.sh'), 'utf8');

function installerFunction(name: string): string {
  const match = INSTALL_SH.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'));
  if (!match) throw new Error(`${name}() not found in openclaw/install.sh`);
  return match[0];
}

/** Runs one installer function against a stand-in `openclaw` that prints the given host output. */
function runAgainstHost(functionName: string, hostOutput: string, hostExitCode: number) {
  const script = [
    'set -euo pipefail',
    'success() { echo "success: $*"; }',
    'info() { echo "info: $*"; }',
    'error() { echo "error: $*" >&2; }',
    'OPENCLAW_PATH=openclaw',
    // fd 9 records each call outside the function's own output capture.
    'exec 9>&2',
    'run_openclaw() { echo "ran: $*" >&9; printf "%s\\n" "$HOST_OUTPUT"; return "$HOST_EXIT_CODE"; }',
    installerFunction(functionName),
    functionName,
  ].join('\n');
  return spawnSync('bash', ['-c', script], {
    env: { ...process.env, HOST_OUTPUT: hostOutput, HOST_EXIT_CODE: String(hostExitCode) },
    encoding: 'utf8',
  });
}

// Option lists as `openclaw plugins install --help` prints them.
const OPENCLAW_2026_2_9_INSTALL_HELP = `Options:
  -h, --help    display help for command
  -l, --link    Link a local path instead of copying (default: false)`;
const OPENCLAW_2026_11_2_INSTALL_HELP = `Options:
  --accept-capabilities                 Accept the plugin's declared
  --dangerously-force-unsafe-install    Deprecated no-op; security.installPolicy
  --force                               Confirm non-ClawHub sources and
  -h, --help                            Display help for command`;

describe('openclaw install.sh across OpenClaw versions', () => {
  it('confirms the source and capabilities on hosts that ask for them (#5838)', () => {
    const result = runAgainstHost('openclaw_install_confirmation_flags', OPENCLAW_2026_11_2_INSTALL_HELP, 0);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['--force', '--accept-capabilities']);
  });

  it('passes no confirmation flags to hosts that would reject them', () => {
    const result = runAgainstHost('openclaw_install_confirmation_flags', OPENCLAW_2026_2_9_INSTALL_HELP, 0);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('does not read --dangerously-force-unsafe-install as --force', () => {
    const helpWithoutForce = '  --dangerously-force-unsafe-install    Deprecated no-op';
    const result = runAgainstHost('openclaw_install_confirmation_flags', helpWithoutForce, 0);
    expect(result.stdout).toBe('');
  });

  it('allows conversation hooks through OpenClaw config validation', () => {
    const result = runAgainstHost('allow_conversation_hooks', 'Updated plugins.entries.claude-mem.hooks.allowConversationAccess.', 0);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('ran: config set plugins.entries.claude-mem.hooks.allowConversationAccess true');
    expect(result.stdout).toContain('success: Allowed');
  });

  it('accepts hosts that have no conversation-hook gate', () => {
    const oldHostRefusal = 'Error: Config validation failed: plugins.entries.claude-mem: Unrecognized key: "hooks"';
    const result = runAgainstHost('allow_conversation_hooks', oldHostRefusal, 1);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('does not gate conversation hooks');
  });

  it('stops the install when the grant fails for any other reason', () => {
    const result = runAgainstHost('allow_conversation_hooks', 'Error: config is locked', 1);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error: config is locked');
    expect(result.stderr).toContain('config set plugins.entries.claude-mem.hooks.allowConversationAccess true');
  });
});
