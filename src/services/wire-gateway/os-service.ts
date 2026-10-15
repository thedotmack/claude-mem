// SPDX-License-Identifier: Apache-2.0
//
// Per-user OS service for the wire gateway (plan D14). After a reboot, wired
// agents need the gateway before any Claude Code session starts the worker,
// and claude-mem has no OS autostart of its own. Every service runs
// `bun <plugin>/scripts/wire-gateway-service.cjs start --foreground`.
//
//   macOS   ~/Library/LaunchAgents/ai.claude-mem.wire-gateway.plist
//           https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html
//   Linux   ~/.config/systemd/user/claude-mem-wire-gateway.service
//           https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
//   Windows schtasks /Create /SC ONLOGON
//           https://learn.microsoft.com/windows-server/administration/windows-commands/schtasks-create

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { DATA_DIR } from '../../shared/paths.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { logger } from '../../utils/logger.js';

export const LAUNCH_AGENT_LABEL = 'ai.claude-mem.wire-gateway';
export const SYSTEMD_UNIT_NAME = 'claude-mem-wire-gateway.service';
export const WINDOWS_TASK_NAME = 'claude-mem wire gateway';

// How long past the drain budget a supervisor waits after SIGTERM before it
// SIGKILLs the gateway. `wire stop` waits the same window.
export const WIRE_GATEWAY_STOP_EXIT_MARGIN_MS = 15_000;

export interface WireGatewayServiceCommand {
  bunPath: string;
  scriptPath: string;
  /** CLAUDE_MEM_WIRE_GATEWAY_DRAIN_TIMEOUT_MS: the supervisor's stop timeout covers it. */
  drainTimeoutMs: number;
  /** Defaults to the resolved DATA_DIR, so a shell-only CLAUDE_MEM_DATA_DIR survives a reboot. */
  dataDir?: string;
}

/** Seconds a supervisor must allow between SIGTERM and exit: the drain plus a margin. */
export function serviceStopTimeoutSeconds(drainTimeoutMs: number): number {
  return Math.ceil((drainTimeoutMs + WIRE_GATEWAY_STOP_EXIT_MARGIN_MS) / 1000);
}

function serviceArguments(command: WireGatewayServiceCommand): string[] {
  return [command.bunPath, command.scriptPath, 'start', '--foreground'];
}

export function launchAgentPlistPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

export function systemdUnitPath(home: string = homedir()): string {
  return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * KeepAlive restarts the gateway only after a failed exit: `wire stop` and a
 * second instance that finds one already running both exit 0 and stay down.
 */
export function buildLaunchAgentPlist(command: WireGatewayServiceCommand): string {
  const dataDir = command.dataDir ?? DATA_DIR;
  const programArguments = serviceArguments(command)
    .map(argument => `    <string>${escapeXml(argument)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_MEM_DATA_DIR</key>
    <string>${escapeXml(dataDir)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(dataDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>ExitTimeOut</key>
  <integer>${serviceStopTimeoutSeconds(command.drainTimeoutMs)}</integer>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
</dict>
</plist>
`;
}

/** systemd quotes: wrap in double quotes, escape backslash and double quote. */
function quoteSystemdArgument(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildSystemdUnit(command: WireGatewayServiceCommand): string {
  const dataDir = command.dataDir ?? DATA_DIR;
  return `[Unit]
Description=claude-mem wire gateway

[Service]
Type=simple
ExecStart=${serviceArguments(command).map(quoteSystemdArgument).join(' ')}
Environment=${quoteSystemdArgument(`CLAUDE_MEM_DATA_DIR=${dataDir}`)}
WorkingDirectory=${quoteSystemdArgument(dataDir)}
Restart=on-failure
TimeoutStopSec=${serviceStopTimeoutSeconds(command.drainTimeoutMs)}

[Install]
WantedBy=default.target
`;
}

/**
 * A logon task has no environment of its own, so the task runs cmd.exe to set
 * CLAUDE_MEM_DATA_DIR before it starts Bun. `/s` makes cmd strip only the
 * outer quotes. Windows has no SIGTERM drain to wait for (stop tree-kills).
 * https://learn.microsoft.com/windows-server/administration/windows-commands/cmd
 */
export function buildSchtasksCreateArguments(command: WireGatewayServiceCommand): string[] {
  const dataDir = command.dataDir ?? DATA_DIR;
  const bunCommand = serviceArguments(command).map(argument => (argument.includes(' ') ? `"${argument}"` : argument)).join(' ');
  const taskRun = `cmd.exe /d /s /c "set "CLAUDE_MEM_DATA_DIR=${dataDir}"&& ${bunCommand}"`;
  return ['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', WINDOWS_TASK_NAME, '/TR', taskRun];
}

/** Run an OS service manager command with a sanitized env. Throws with its stderr on failure. */
function runServiceManager(executable: string, args: string[], options: { allowFailure?: boolean } = {}): void {
  const result = spawnSync(executable, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: sanitizeEnv(process.env),
  });
  if (result.error) {
    throw new Error(`${executable} could not run: ${result.error.message}`);
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${executable} ${args.join(' ')} exited ${result.status ?? 'null'}: ${(result.stderr ?? '').trim()}`);
  }
}

function launchctlDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('launchctl needs a user id');
  }
  return `gui/${uid}`;
}

/** Install and start the per-user service. Returns a line for the user. */
export function installWireGatewayOsService(command: WireGatewayServiceCommand): string {
  switch (process.platform) {
    case 'darwin': {
      const plistPath = launchAgentPlistPath();
      mkdirSync(dirname(plistPath), { recursive: true });
      writeFileSync(plistPath, buildLaunchAgentPlist(command));
      // bootout first so a changed plist replaces the loaded one; it fails when nothing is loaded.
      runServiceManager('launchctl', ['bootout', launchctlDomain(), plistPath], { allowFailure: true });
      runServiceManager('launchctl', ['bootstrap', launchctlDomain(), plistPath]);
      logger.info('WIRE', 'Installed wire gateway LaunchAgent', { plistPath });
      return `Installed ${plistPath}`;
    }
    case 'linux': {
      const unitPath = systemdUnitPath();
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, buildSystemdUnit(command));
      runServiceManager('systemctl', ['--user', 'daemon-reload']);
      runServiceManager('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME]);
      logger.info('WIRE', 'Installed wire gateway systemd user unit', { unitPath });
      return `Installed ${unitPath}`;
    }
    case 'win32': {
      runServiceManager('schtasks', buildSchtasksCreateArguments(command));
      runServiceManager('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAME], { allowFailure: true });
      logger.info('WIRE', 'Installed wire gateway logon task', { taskName: WINDOWS_TASK_NAME });
      return `Installed logon task "${WINDOWS_TASK_NAME}"`;
    }
    default:
      throw new Error(`claude-mem wire service install does not support ${process.platform}`);
  }
}

/** Stop and remove the per-user service. Returns a line for the user. */
export function uninstallWireGatewayOsService(): string {
  switch (process.platform) {
    case 'darwin': {
      const plistPath = launchAgentPlistPath();
      if (!existsSync(plistPath)) return 'Wire gateway LaunchAgent is not installed';
      runServiceManager('launchctl', ['bootout', launchctlDomain(), plistPath], { allowFailure: true });
      rmSync(plistPath, { force: true });
      return `Removed ${plistPath}`;
    }
    case 'linux': {
      const unitPath = systemdUnitPath();
      if (!existsSync(unitPath)) return 'Wire gateway systemd user unit is not installed';
      runServiceManager('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME], { allowFailure: true });
      rmSync(unitPath, { force: true });
      runServiceManager('systemctl', ['--user', 'daemon-reload']);
      return `Removed ${unitPath}`;
    }
    case 'win32': {
      runServiceManager('schtasks', ['/Delete', '/F', '/TN', WINDOWS_TASK_NAME]);
      return `Removed logon task "${WINDOWS_TASK_NAME}"`;
    }
    default:
      throw new Error(`claude-mem wire service uninstall does not support ${process.platform}`);
  }
}
