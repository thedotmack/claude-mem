import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { GOLDEN_DIRECTORY, goldenPath, runInstallerScenario, type InstallerSnapshot } from './library/golden-harness.js';
import { deviationReasonFor } from './library/golden-deviations.js';
import { SCENARIO_NAMES } from './library/installer-scenarios.js';

// Plan Phase 14 task 4: every installer ported onto the Library reproduces
// the bytes the pre-Library installer wrote (the goldens, taken from the old
// code at 6d4c1509e by capture-goldens.ts), except the deviations listed with
// their reason in golden-deviations.ts, whose post-port bytes are pinned in
// deviations.json. Each scenario runs in a child process with a sandboxed
// HOME, so no real agent config is ever read or written.

const SANDBOX_PARENT = join(WIRE_GATEWAY_DIR, 'tmp', `library-golden-${process.pid}`);
/** A scenario child spawns Bun and sometimes fake agent CLIs; one takes about a second, the bound leaves room on a loaded CI box. */
const SCENARIO_TEST_TIMEOUT_MS = 60_000;

const deviations = JSON.parse(readFileSync(join(GOLDEN_DIRECTORY, 'deviations.json'), 'utf-8')) as Record<string, Record<string, { reason: string; after: string | null }>>;

mkdirSync(SANDBOX_PARENT, { recursive: true });
afterAll(() => rmSync(SANDBOX_PARENT, { recursive: true, force: true }));

describe('ported installers reproduce the pre-Library goldens', () => {
  for (const scenario of SCENARIO_NAMES) {
    it(scenario, () => {
      const golden = JSON.parse(readFileSync(goldenPath(scenario), 'utf-8')) as InstallerSnapshot;
      const actual = runInstallerScenario(scenario, SANDBOX_PARENT);
      expect(actual.exitCodes).toEqual(golden.exitCodes);
      const allowed = deviations[scenario] ?? {};
      for (const path of [...new Set([...Object.keys(golden.files), ...Object.keys(actual.files)])].sort()) {
        const deviation = allowed[path];
        if (deviation) {
          // A recorded deviation is still explained, still different from the golden, and pinned to its reviewed bytes.
          expect(deviationReasonFor(scenario, path)).toBe(deviation.reason);
          expect(deviation.after).not.toBe(golden.files[path] ?? null);
          expect({ path, bytes: actual.files[path] ?? null }).toEqual({ path, bytes: deviation.after });
        } else {
          expect({ path, bytes: actual.files[path] ?? null }).toEqual({ path, bytes: golden.files[path] ?? null });
        }
      }
    }, SCENARIO_TEST_TIMEOUT_MS);
  }

  it('never creates a Codex hook trust record (it tells the user to trust the hooks instead)', () => {
    for (const scenario of SCENARIO_NAMES.filter((name) => name.startsWith('codex') || name.startsWith('t3code'))) {
      const actual = runInstallerScenario(scenario, SANDBOX_PARENT);
      for (const [path, bytes] of Object.entries(actual.files)) {
        if (path.endsWith('config.toml')) expect({ path, trust: bytes.includes('[hooks.state') }).toEqual({ path, trust: false });
      }
    }
  }, SCENARIO_TEST_TIMEOUT_MS);

  it('every recorded deviation belongs to a scenario that still runs', () => {
    for (const scenario of Object.keys(deviations)) expect(SCENARIO_NAMES).toContain(scenario);
  });
});
