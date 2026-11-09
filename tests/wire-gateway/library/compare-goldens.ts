// Run scenarios against the current installers and print every difference
// from the goldens (a working aid for the port; the parity test asserts).
//
//   bun tests/wire-gateway/library/compare-goldens.ts <sandboxParent> [scenario…]

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { goldenPath, runInstallerScenario, type InstallerSnapshot } from './golden-harness.js';
import { SCENARIO_NAMES } from './installer-scenarios.js';

const [sandboxParent, ...only] = process.argv.slice(2);
if (!sandboxParent) throw new Error('usage: compare-goldens.ts <sandboxParent> [scenario…]');
let differing = 0;
for (const scenario of only.length > 0 ? only : SCENARIO_NAMES) {
  const golden = JSON.parse(readFileSync(goldenPath(scenario), 'utf-8')) as InstallerSnapshot;
  const actual = runInstallerScenario(scenario, resolve(sandboxParent));
  const lines: string[] = [];
  if (JSON.stringify(golden.exitCodes) !== JSON.stringify(actual.exitCodes)) lines.push(`  exit codes: golden ${golden.exitCodes} actual ${actual.exitCodes}`);
  for (const path of [...new Set([...Object.keys(golden.files), ...Object.keys(actual.files)])].sort()) {
    if (golden.files[path] === actual.files[path]) continue;
    lines.push(`  ${path}:\n    golden: ${JSON.stringify(golden.files[path])}\n    actual: ${JSON.stringify(actual.files[path])}`);
  }
  if (lines.length > 0) differing++;
  process.stdout.write(`${scenario}: ${lines.length === 0 ? 'identical' : 'DIFFERS'}\n${lines.join('\n')}${lines.length ? '\n' : ''}`);
}
process.stdout.write(`${differing} scenario(s) differ\n`);
