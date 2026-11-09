import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../../src/shared/paths.js';
import type { AgentEnvironment } from '../../../src/services/wire-gateway/agents/types.js';
import type { WiringOptions, WiringSideEffects } from '../../../src/services/wire-gateway/wiring/wiring-engine.js';

export const TEST_GATEWAY_ORIGIN = 'http://127.0.0.1:37699';

let sandboxCounter = 0;

export interface RecordedSideEffects extends WiringSideEffects {
  calls: string[];
  serviceInstalled: boolean;
}

/** Side effects that only record what was asked: no daemon, no OS service, probes answer `probeAnswers`. */
export function recordingSideEffects(options: { probeAnswers?: boolean; serviceInstalled?: boolean; installThrows?: boolean } = {}): RecordedSideEffects {
  const recorded: RecordedSideEffects = {
    calls: [],
    serviceInstalled: options.serviceInstalled ?? false,
    ensureGatewayRunning: async () => { recorded.calls.push('ensureGatewayRunning'); },
    stopGateway: async () => { recorded.calls.push('stopGateway'); },
    isOsServiceInstalled: () => recorded.serviceInstalled,
    installOsService: () => {
      recorded.calls.push('installOsService');
      if (options.installThrows) throw new Error('systemctl --user is not available');
      recorded.serviceInstalled = true;
      return 'Installed the test service';
    },
    uninstallOsService: () => {
      recorded.calls.push('uninstallOsService');
      recorded.serviceInstalled = false;
      return 'Removed the test service';
    },
    probeRouteIdentity: async (url: string) => {
      recorded.calls.push(`probe ${url}`);
      return options.probeAnswers ?? true;
    },
  };
  return recorded;
}

/**
 * A fake home and claude-mem state under the test data dir (never a real
 * ~/.codex or ~/.claude). Every agent path resolves inside `home`.
 */
export class WiringSandbox {
  readonly root: string;
  readonly home: string;
  readonly wiringDirectory: string;
  readonly routesFilePath: string;
  readonly env: Record<string, string | undefined>;

  constructor(label: string, env: Record<string, string | undefined> = {}) {
    this.root = join(WIRE_GATEWAY_DIR, 'tmp', `wiring-test-${process.pid}-${label}-${sandboxCounter++}`);
    this.home = join(this.root, 'home');
    this.wiringDirectory = join(this.root, 'state', 'wiring');
    this.routesFilePath = join(this.root, 'state', 'routes.json');
    mkdirSync(this.home, { recursive: true });
    this.env = { PATH: join(this.root, 'bin'), ...env };
  }

  get environment(): AgentEnvironment {
    return { home: this.home, env: this.env, platform: process.platform === 'win32' ? 'win32' : process.platform };
  }

  path(relativePath: string): string {
    return join(this.home, relativePath);
  }

  write(relativePath: string, text: string): string {
    const target = this.path(relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    return target;
  }

  read(relativePath: string): string | null {
    const target = this.path(relativePath);
    return existsSync(target) ? readFileSync(target, 'utf-8') : null;
  }

  options(sideEffects: WiringSideEffects = recordingSideEffects(), helpers: WiringOptions['helpers'] = { readAgentVersion: () => null }): WiringOptions {
    return {
      environment: this.environment,
      gatewayOrigin: TEST_GATEWAY_ORIGIN,
      wiringDirectory: this.wiringDirectory,
      routesFilePath: this.routesFilePath,
      sideEffects,
      helpers,
    };
  }

  remove(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
