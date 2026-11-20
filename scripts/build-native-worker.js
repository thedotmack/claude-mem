#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { workerBinaryBuildOptions } from './worker-binary-build-options.js';

const args = process.argv.slice(2);
if (args.includes('--check-runtime')) {
  workerBinaryBuildOptions({ outfile: 'unused' });
  process.exit(0);
}
const native = args.includes('--native');
const outputIndex = args.indexOf('--outfile');
if (outputIndex !== -1 && (!args[outputIndex + 1] || args[outputIndex + 1].startsWith('--'))) {
  throw new Error('--outfile requires a path');
}
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const outfile = path.resolve(outputIndex !== -1 ? args[outputIndex + 1]
  : native ? 'plugin/scripts/claude-mem' : `dist/binaries/worker-service-v${version}-win-x64.exe`);
fs.mkdirSync(path.dirname(outfile), { recursive: true });
const result = await Bun.build(workerBinaryBuildOptions({
  outfile, target: native ? undefined : 'bun-windows-x64',
}));
for (const log of result.logs) console.error(log);
if (!result.success) process.exit(1);
console.log(`Built: ${outfile}`);
