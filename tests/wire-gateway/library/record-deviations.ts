// Record the post-port bytes of every golden deviation (after reviewing
// them). Fails when a difference has no reason in golden-deviations.ts.
//
//   bun tests/wire-gateway/library/record-deviations.ts <sandboxParent>

import { readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { GOLDEN_DIRECTORY, goldenPath, runInstallerScenario, type InstallerSnapshot } from './golden-harness.js';
import { deviationReasonFor } from './golden-deviations.js';
import { SCENARIO_NAMES } from './installer-scenarios.js';

const [sandboxParent] = process.argv.slice(2);
if (!sandboxParent) throw new Error('usage: record-deviations.ts <sandboxParent>');
const deviations: Record<string, Record<string, { reason: string; after: string | null }>> = {};
const unexplained: string[] = [];
for (const scenario of SCENARIO_NAMES) {
  const golden = JSON.parse(readFileSync(goldenPath(scenario), 'utf-8')) as InstallerSnapshot;
  const actual = runInstallerScenario(scenario, resolve(sandboxParent));
  if (JSON.stringify(golden.exitCodes) !== JSON.stringify(actual.exitCodes)) unexplained.push(`${scenario}: exit codes ${golden.exitCodes} → ${actual.exitCodes}`);
  for (const path of [...new Set([...Object.keys(golden.files), ...Object.keys(actual.files)])].sort()) {
    if (golden.files[path] === actual.files[path]) continue;
    const reason = deviationReasonFor(scenario, path);
    if (!reason) {
      unexplained.push(`${scenario}: ${path}`);
      continue;
    }
    (deviations[scenario] ??= {})[path] = { reason, after: actual.files[path] ?? null };
  }
}
if (unexplained.length > 0) throw new Error(`differences with no reason:\n${unexplained.join('\n')}`);
writeFileSync(join(GOLDEN_DIRECTORY, 'deviations.json'), `${JSON.stringify(deviations, null, 2)}\n`);
process.stdout.write(`${Object.values(deviations).reduce((count, files) => count + Object.keys(files).length, 0)} deviating file(s) recorded\n`);
