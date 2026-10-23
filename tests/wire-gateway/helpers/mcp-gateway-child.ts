// A wire gateway in its own process, for tests that need an environment
// set at launch (Bun reads HTTP_PROXY then). Prints `READY <port>` and runs
// until killed.
import { join } from 'path';
import { startWireGatewayForTest } from './start-wire-gateway.js';

const gateway = await startWireGatewayForTest({ routesFilePath: join(process.env.CLAUDE_MEM_DATA_DIR ?? '.', 'mcp-child-routes.json') });
process.stdout.write(`READY ${gateway.port}\n`);
setInterval(() => undefined, 1 << 30);
