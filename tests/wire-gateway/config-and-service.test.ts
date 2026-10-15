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
  const command = { bunPath: '/Users/me/.bun/bin/bun', scriptPath: '/plugin dir/scripts/wire-gateway-service.cjs', dataDir: '/Users/me/.claude-mem' };

  it('launchd plist runs `start --foreground` at load and restarts only after a failure', () => {
    const plist = buildLaunchAgentPlist(command);
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain('<string>/Users/me/.bun/bin/bun</string>\n    <string>/plugin dir/scripts/wire-gateway-service.cjs</string>\n    <string>start</string>\n    <string>--foreground</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>');
    expect(plist).toContain('<key>CLAUDE_MEM_DATA_DIR</key>\n    <string>/Users/me/.claude-mem</string>');
    expect(buildLaunchAgentPlist({ ...command, dataDir: '/a&b' })).toContain('/a&amp;b');
  });

  it('systemd user unit quotes paths with spaces', () => {
    const unit = buildSystemdUnit(command);
    expect(unit).toContain('ExecStart="/Users/me/.bun/bin/bun" "/plugin dir/scripts/wire-gateway-service.cjs" "start" "--foreground"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('schtasks creates an ONLOGON task', () => {
    const args = buildSchtasksCreateArguments(command);
    expect(args.slice(0, 4)).toEqual(['/Create', '/F', '/SC', 'ONLOGON']);
    expect(args[args.length - 1]).toBe('/Users/me/.bun/bin/bun "/plugin dir/scripts/wire-gateway-service.cjs" start --foreground');
  });
});

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
