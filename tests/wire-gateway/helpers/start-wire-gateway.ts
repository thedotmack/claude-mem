import {
  WireGatewayService,
  type WireGatewayServiceOptions,
} from '../../../src/services/wire-gateway/WireGatewayService.js';

export interface StartedWireGateway {
  service: WireGatewayService;
  port: number;
  baseUrl: string;
  stop(): Promise<void>;
}

/**
 * Starts the wire gateway in this process on an OS-picked port. Data lands in
 * the preload's temp CLAUDE_MEM_DATA_DIR (tests/preload.ts), never ~/.claude-mem.
 * State files are off by default so parallel test files never share a PID file.
 */
export async function startWireGatewayForTest(
  options: Partial<WireGatewayServiceOptions> = {},
): Promise<StartedWireGateway> {
  const service = new WireGatewayService({
    host: '127.0.0.1',
    port: 0,
    drainTimeoutMs: 5_000,
    maxRequestBytes: 64 * 1024 * 1024,
    persistRuntimeState: false,
    ...options,
  });
  await service.start();
  const port = service.port;
  return {
    service,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => service.stop(),
  };
}
