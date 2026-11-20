import { mock } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as jsonUtils from '../../../src/utils/json-utils.js';

const directory = process.env.CLAUDE_MEM_DATA_DIR!;
const originalRead = jsonUtils.readJsonSafe;
let paused = false;
if (process.argv[3] === 'pause') {
  mock.module('../../../src/utils/json-utils.js', () => ({
    ...jsonUtils,
    readJsonSafe: (path: string, fallback: unknown) => {
      const value = originalRead(path, fallback);
      if (!paused && path === join(directory, 'telemetry.json')) {
        paused = true;
        writeFileSync(join(directory, 'read-ready'), 'ready');
        const deadline = Date.now() + 8_000;
        while (!existsSync(join(directory, 'read-release'))) {
          if (Date.now() > deadline) throw new Error('Fixture read barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
      return value;
    },
  }));
}

try {
  if (process.argv[2] === 'notice') {
    const { consumeTelemetryNotice } = await import('../../../src/services/telemetry/consent.js');
    console.log(JSON.stringify({ notice: consumeTelemetryNotice() }));
  } else {
    const { runTelemetryCommand } = await import('../../../src/npx-cli/commands/telemetry.js');
    await runTelemetryCommand(['disable']);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
