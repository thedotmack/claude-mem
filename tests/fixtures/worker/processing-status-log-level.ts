import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import vm from 'node:vm';

type ProcessingStatus = {
  type: 'processing_status';
  isProcessing: boolean;
  queueDepth: number;
};

const queueDepth = Number(process.argv[3]);
const iterations = Number(process.argv[4]);
const updates: ProcessingStatus[] = [];
const context = {
  sessionManager: {
    getTotalActiveWork: async () => queueDepth,
    getActiveSessionCount: () => 1,
  },
  sseBroadcaster: {
    broadcast: (event: ProcessingStatus) => { updates.push(event); },
  },
};

type WorkerModule = {
  WorkerService: { prototype: { broadcastProcessingStatus(this: typeof context): void } };
};

const modulePath = process.argv[2];
let workerModule: WorkerModule;
if (modulePath.endsWith('.cjs')) {
  const cjsModule = { exports: {} as WorkerModule, parent: {} };
  const code = readFileSync(modulePath, 'utf8').replace(/^#!.*\n/, '');
  const load = new vm.Script(`(function(require, module, exports, __filename, __dirname) {\n${code}\n})`, { filename: modulePath });
  load.runInThisContext()(createRequire(pathToFileURL(modulePath)), cjsModule, cjsModule.exports, modulePath, dirname(modulePath));
  workerModule = cjsModule.exports;
} else {
  workerModule = await import(pathToFileURL(modulePath).href);
}

for (let iteration = 0; iteration < iterations; iteration++) {
  workerModule.WorkerService.prototype.broadcastProcessingStatus.call(context);
}
await setImmediate();

process.stdout.write(JSON.stringify({
  count: updates.length,
  event: updates[0],
  allEqual: updates.every(event => JSON.stringify(event) === JSON.stringify(updates[0])),
}));
