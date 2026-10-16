import { describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  assertWireGatewayBun,
  validateWireGatewayListenSettings,
} from '../../src/services/wire-gateway/config.js';
import { countWireGatewayRoutes, ensureWireGatewayRunning } from '../../src/services/wire-gateway/WireGatewayService.js';
import {
  LAUNCH_AGENT_LABEL,
  buildLaunchAgentPlist,
  buildSchtasksCreateArguments,
  buildSystemdUnit,
  serviceStopTimeoutSeconds,
} from '../../src/services/wire-gateway/os-service.js';
import { parseWorkerServiceCommand } from '../../src/services/worker-service.js';
import { DATA_DIR, ensureWireGatewayDirs, paths } from '../../src/shared/paths.js';

describe('wire gateway Bun gate', () => {
  it('throws the upgrade message below 1.3.6', () => {
    expect(() => assertWireGatewayBun('1.3.5')).toThrow('claude-mem wire gateway needs Bun ≥ 1.3.6 (found 1.3.5). Run: bun upgrade');
    expect(() => assertWireGatewayBun('1.1.31')).toThrow('found 1.1.31');
  });

  it('accepts 1.3.6 and newer', () => {
    for (const version of ['1.3.6', '1.3.9', '1.4.0', '2.0.0']) {
      expect(() => assertWireGatewayBun(version)).not.toThrow();
    }
  });

  it('accepts the running Bun by default (this suite runs on ≥ 1.3.6)', () => {
    expect(() => assertWireGatewayBun()).not.toThrow();
  });
});

describe('wire gateway listen settings validation', () => {
  it('accepts the defaults and loopback hosts', () => {
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_PORT: '37677', CLAUDE_MEM_WIRE_GATEWAY_HOST: '127.0.0.1' })).toBeNull();
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_HOST: '::1' })).toBeNull();
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_HOST: 'localhost' })).toBeNull();
  });

  it('refuses out-of-range ports, non-loopback hosts and non-numeric drain timeouts', () => {
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_PORT: '80' })).toContain('between 1024 and 65535');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_PORT: 'abc' })).toContain('between 1024 and 65535');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_HOST: '0.0.0.0' })).toContain('loopback');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_HOST: '192.168.1.2' })).toContain('loopback');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_DRAIN_TIMEOUT_MS: '10s' })).toContain('whole number');
  });

  it('refuses a request byte limit that is not a positive whole number', () => {
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_MAX_REQUEST_BYTES: '67108864' })).toBeNull();
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_MAX_REQUEST_BYTES: '0' })).toContain('above 0');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_MAX_REQUEST_BYTES: '64MB' })).toContain('above 0');
  });
});

describe('wire gateway routes.json counting (worker autostart)', () => {
  const dir = join(DATA_DIR, 'wire-gateway-route-count-test');
  mkdirSync(dir, { recursive: true });

  it('absent file means no routes', () => {
    expect(countWireGatewayRoutes(join(dir, 'missing.json'))).toBe(0);
  });

  it('counts routes', () => {
    const file = join(dir, 'two.json');
    const route = { agentId: 'codex', upstreamBaseUrl: 'https://api.openai.com/v1', captureSource: 'wire', features: {}, createdAt: '2026-10-15T00:00:00.000Z' };
    writeFileSync(file, JSON.stringify({ version: 1, routes: { a: route, b: route } }));
    expect(countWireGatewayRoutes(file)).toBe(2);
  });

  it('an unreadable file is unknown (null), never empty', () => {
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{not json');
    expect(countWireGatewayRoutes(corrupt)).toBeNull();
    const wrongShape = join(dir, 'wrong.json');
    writeFileSync(wrongShape, JSON.stringify({ routes: [] }));
    expect(countWireGatewayRoutes(wrongShape)).toBeNull();
  });
});

describe('wire gateway OS service definitions', () => {
  const command = {
    bunPath: '/Users/me/.bun/bin/bun',
    scriptPath: '/plugin dir/scripts/wire-gateway-service.cjs',
    dataDir: '/Users/me/.claude-mem',
    drainTimeoutMs: 600_000,
  };

  it('stop timeout is the drain budget plus a margin, in whole seconds', () => {
    expect(serviceStopTimeoutSeconds(600_000)).toBe(615);
    expect(serviceStopTimeoutSeconds(1_500)).toBe(17);
  });

  it('launchd plist runs `start --foreground` at load and restarts only after a failure', () => {
    const plist = buildLaunchAgentPlist(command);
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain('<string>/Users/me/.bun/bin/bun</string>\n    <string>/plugin dir/scripts/wire-gateway-service.cjs</string>\n    <string>start</string>\n    <string>--foreground</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>');
    expect(plist).toContain('<key>CLAUDE_MEM_DATA_DIR</key>\n    <string>/Users/me/.claude-mem</string>');
    expect(buildLaunchAgentPlist({ ...command, dataDir: '/a&b' })).toContain('/a&amp;b');
  });

  it('launchd plist waits past the drain budget before SIGKILL (ExitTimeOut)', () => {
    expect(buildLaunchAgentPlist(command)).toContain('<key>ExitTimeOut</key>\n  <integer>615</integer>');
    expect(buildLaunchAgentPlist({ ...command, drainTimeoutMs: 10_000 })).toContain('<integer>25</integer>');
  });

  it('launchd plist defaults CLAUDE_MEM_DATA_DIR to the resolved data dir', () => {
    const { dataDir: _omitted, ...withoutDataDir } = command;
    expect(buildLaunchAgentPlist(withoutDataDir)).toContain(`<key>CLAUDE_MEM_DATA_DIR</key>\n    <string>${DATA_DIR}</string>`);
  });

  it('systemd user unit quotes paths with spaces', () => {
    const unit = buildSystemdUnit(command);
    expect(unit).toContain('ExecStart="/Users/me/.bun/bin/bun" "/plugin dir/scripts/wire-gateway-service.cjs" "start" "--foreground"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('systemd user unit waits past the drain budget before SIGKILL and keeps the data dir', () => {
    const unit = buildSystemdUnit(command);
    expect(unit).toContain('TimeoutStopSec=615\n');
    expect(unit).toContain('Environment="CLAUDE_MEM_DATA_DIR=/Users/me/.claude-mem"');
    const { dataDir: _omitted, ...withoutDataDir } = command;
    expect(buildSystemdUnit(withoutDataDir)).toContain(`Environment="CLAUDE_MEM_DATA_DIR=${DATA_DIR}"`);
  });

  it('schtasks creates an ONLOGON task that sets CLAUDE_MEM_DATA_DIR before starting Bun', () => {
    const args = buildSchtasksCreateArguments({ ...command, dataDir: 'C:\\Users\\me\\mem data' });
    expect(args.slice(0, 4)).toEqual(['/Create', '/F', '/SC', 'ONLOGON']);
    expect(args[args.length - 1]).toBe(
      'cmd.exe /d /v:off /s /c "set CLAUDE_MEM_DATA_DIR=C:\\Users\\me\\mem data&& "/Users/me/.bun/bin/bun" "/plugin dir/scripts/wire-gateway-service.cjs" "start" "--foreground""',
    );
  });

  it('schtasks task defaults CLAUDE_MEM_DATA_DIR to the resolved data dir', () => {
    const { dataDir: _omitted, ...withoutDataDir } = command;
    const args = buildSchtasksCreateArguments(withoutDataDir);
    expect(args[args.length - 1]).toContain('set CLAUDE_MEM_DATA_DIR=');
    expect(parseCmdTaskLine(args[args.length - 1]).dataDir).toBe(DATA_DIR);
  });

  it('schtasks task line survives cmd metacharacters (& ^ % ( ) ! spaces) in every path', () => {
    const awkwardDataDir = 'C:\\Users\\AT&T (x86)\\100%USERNAME% ^caret! data';
    const awkwardCommand = {
      bunPath: 'C:\\Users\\AT&T\\.bun\\bin\\bun.exe',
      scriptPath: 'C:\\Users\\AT&T (x86)\\%PATH%\\a^b!c\\wire-gateway-service.cjs',
      drainTimeoutMs: 600_000,
      dataDir: awkwardDataDir,
    };
    const taskRun = buildSchtasksCreateArguments(awkwardCommand).at(-1)!;
    expect(parseCmdTaskLine(taskRun)).toEqual({
      dataDir: awkwardDataDir,
      argv: [awkwardCommand.bunPath, awkwardCommand.scriptPath, 'start', '--foreground'],
    });
  });

  it('schtasks refuses a path with a double quote rather than writing a broken task', () => {
    expect(() => buildSchtasksCreateArguments({ ...command, dataDir: 'C:\\a"b' })).toThrow('double quote');
  });
});

/**
 * A model of how cmd.exe /d /v:off /s /c "<line>" runs the task line
 * (https://ss64.com/nt/syntax-esc.html): /s strips the outer quotes; pass 1
 * expands %NAME% for any NAME that could be defined (modelled as: one free of
 * quotes and carets); pass 2 splits on unescaped `&&` outside quotes and
 * removes `^` escapes there. The program then splits its own argv
 * (quotes delimit, are dropped).
 */
function parseCmdTaskLine(taskRun: string): { dataDir: string; argv: string[] } {
  const prefix = 'cmd.exe /d /v:off /s /c "';
  expect(taskRun.startsWith(prefix) && taskRun.endsWith('"')).toBe(true);
  const line = taskRun.slice(prefix.length, -1);
  for (const reference of line.matchAll(/%([^%]*)%/g)) {
    // A variable reference cmd would expand: its name must contain a caret or quote.
    expect(/[\^"]/.test(reference[1])).toBe(true);
  }
  const commands: string[] = [''];
  let inQuotes = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') inQuotes = !inQuotes;
    if (!inQuotes && character === '^') {
      commands[commands.length - 1] += line[++index];
      continue;
    }
    if (!inQuotes && '&|<>()'.includes(character)) {
      expect(line.slice(index, index + 3)).toBe('&& ');
      commands.push('');
      index += 2;
      continue;
    }
    commands[commands.length - 1] += character;
  }
  expect(commands).toHaveLength(2);
  const setPrefix = 'set CLAUDE_MEM_DATA_DIR=';
  expect(commands[0].startsWith(setPrefix)).toBe(true);
  const argv: string[] = [];
  let current: string | null = null;
  inQuotes = false;
  for (const character of commands[1]) {
    if (character === '"') { inQuotes = !inQuotes; current ??= ''; continue; }
    if (character === ' ' && !inQuotes) { if (current !== null) argv.push(current); current = null; continue; }
    current = (current ?? '') + character;
  }
  if (current !== null) argv.push(current);
  return { dataDir: commands[0].slice(setPrefix.length), argv };
}

describe('worker-service `wire <sub>` dispatch', () => {
  it('maps wire subcommands to wire-<sub> and keeps their args', () => {
    expect(parseWorkerServiceCommand(['wire', 'start', '--foreground'])).toEqual({ command: 'wire-start', args: ['--foreground'] });
    expect(parseWorkerServiceCommand(['wire', 'stop'])).toEqual({ command: 'wire-stop', args: [] });
    expect(parseWorkerServiceCommand(['wire', 'restart'])).toEqual({ command: 'wire-restart', args: [] });
    expect(parseWorkerServiceCommand(['wire', 'status'])).toEqual({ command: 'wire-status', args: [] });
    expect(parseWorkerServiceCommand(['wire', 'service', 'install'])).toEqual({ command: 'wire-service', args: ['install'] });
    expect(parseWorkerServiceCommand(['wire', 'bogus'])).toEqual({ command: 'wire-help', args: [] });
    expect(parseWorkerServiceCommand(['wire'])).toEqual({ command: 'wire-help', args: [] });
  });
});

describe('worker boot autostart (ensureWireGatewayRunning)', () => {
  const missingScript = join(DATA_DIR, 'no-such-dir', 'wire-gateway-service.cjs');

  it('does nothing without routes', async () => {
    rmSync(paths.wireGatewayRoutes(), { force: true });
    await expect(ensureWireGatewayRunning(missingScript)).resolves.toBeUndefined();
  });

  it('with routes but no gateway script, logs and returns without spawning', async () => {
    ensureWireGatewayDirs();
    writeFileSync(paths.wireGatewayRoutes(), JSON.stringify({ version: 1, routes: { test: {} } }));
    try {
      await expect(ensureWireGatewayRunning(missingScript)).resolves.toBeUndefined();
    } finally {
      rmSync(paths.wireGatewayRoutes(), { force: true });
    }
  });
});
