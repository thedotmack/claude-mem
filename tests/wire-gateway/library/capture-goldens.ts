// Take the installer goldens (plan Phase 14 task 4). Run this against the
// installers as they were BEFORE the Library engine; the parity test then
// holds the ported installers to these bytes.
//
//   bun tests/wire-gateway/library/capture-goldens.ts <sandboxParent> [scenario…]

import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { GOLDEN_DIRECTORY, goldenPath, runInstallerScenario } from './golden-harness.js';
import { SCENARIO_NAMES } from './installer-scenarios.js';

const [sandboxParent, ...only] = process.argv.slice(2);
if (!sandboxParent) throw new Error('usage: capture-goldens.ts <sandboxParent> [scenario…]');
mkdirSync(GOLDEN_DIRECTORY, { recursive: true });
for (const scenario of only.length > 0 ? only : SCENARIO_NAMES) {
  const snapshot = runInstallerScenario(scenario, resolve(sandboxParent));
  writeFileSync(goldenPath(scenario), `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`${scenario}: exit ${snapshot.exitCodes.join(',')}, ${Object.keys(snapshot.files).length} files\n`);
}
