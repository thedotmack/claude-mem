import {
  WireGatewayService,
  type WireGatewayServiceOptions,
} from '../../../src/services/wire-gateway/WireGatewayService.js';

export interface StartedWireGateway {
  service: WireGatewayService;
  port: number;
  baseUrl: string;
  /** A shared gateway's team listener (`shared: true`); null otherwise. */
  teamUrl: string | null;
  stop(): Promise<void>;
}

/**
 * Starts the wire gateway in this process on an OS-picked port. Data lands in
 * the preload's temp CLAUDE_MEM_DATA_DIR (tests/preload.ts), never ~/.claude-mem.
 * State files are off by default so parallel test files never share a PID file.
 * Captured events are dropped unless `capture.eventSink` is given.
 */
export async function startWireGatewayForTest(
  options: Partial<WireGatewayServiceOptions> = {},
): Promise<StartedWireGateway> {
  const service = new WireGatewayService({
    host: '127.0.0.1',
    port: 0,
    drainTimeoutMs: 5_000,
    maxRequestBytes: 64 * 1024 * 1024,
    // The settings' own defaults (SettingsDefaultsManager).
    retentionDays: 7,
    outboundRedaction: false,
    forwardSubscriptionSignIns: false,
    persistRuntimeState: false,
    // A shared gateway's team listener: loopback and an OS-picked port in tests.
    ...(options.shared ? { sharedHost: '127.0.0.1', sharedPort: 0 } : {}),
    ...options,
    // Captured events go nowhere unless a test asks for them: a default sink
    // would nudge whatever worker listens on this machine's worker port.
    capture: { eventSink: { emit: () => undefined }, recordingCleanupIntervalMs: 0, ...options.capture },
    // Memory injection is on for wire routes by default (plan D9): a test
    // must never reach whatever worker listens on this machine, so the
    // memory stages see no worker unless a test gives them one.
    memory: {
      injection: { fetchContext: () => Promise.reject(new Error('no worker in this test')), ...options.memory?.injection },
      search: { searcher: () => Promise.reject(new Error('no worker in this test')), ...options.memory?.search },
    },
  });
  await service.start();
  const port = service.port;
  return {
    service,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    teamUrl: options.shared ? `http://127.0.0.1:${service.sharedPort}` : null,
    stop: () => service.stop(),
  };
}
