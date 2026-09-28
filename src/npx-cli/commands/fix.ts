/**
 * `npx claude-mem fix <fix_id> [--advice <advice_id>]`
 *
 * Runs one fix that ships inside this package (install/fix-catalog.ts). An
 * id outside the catalog is refused: the advisor can name a fix, never add
 * one. When the fix followed an advisor answer, the outcome is reported back
 * so the advisor learns which fixes work.
 */

import { parseArgs } from 'node:util';
import { readPluginVersion } from '../utils/paths.js';
import { FIX_CATALOG, FIX_IDS, isKnownFixId } from '../install/fix-catalog.js';
import { printResultLine } from '../install/result-line.js';
import { clearAttempts } from '../install/attempt-guard.js';
import { readLastAdvice, reportAdviceOutcome } from '../install/advisor-client.js';

function safeVersion(): string {
  try {
    return readPluginVersion();
  } catch {
    // [ANTI-PATTERN IGNORED]: the version is only reported in the result line.
    return 'unknown';
  }
}

export async function runFixCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { advice: { type: 'string' } },
    strict: false,
    allowPositionals: true,
  });
  const version = safeVersion();
  const fixId = positionals[0];
  if (!isKnownFixId(fixId)) {
    console.error(`Unknown fix id${fixId ? `: ${String(fixId).slice(0, 60)}` : ''}. This version ships: ${FIX_IDS.join(', ')}`);
    printResultLine({ command: 'fix', status: 'failed', version, errorCategory: 'unknown-fix-id', retrySameCommand: false });
    return 1;
  }

  const fix = FIX_CATALOG[fixId];
  console.log(`Running ${fix.id}: ${fix.title}`);
  let ok = false;
  try {
    ok = await fix.run();
  } catch (error: unknown) {
    console.error(`${fix.id} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // A fix changes the machine, so an earlier "same failure again" verdict no
  // longer holds: the next install should run every step.
  if (ok) clearAttempts();
  console.log(ok ? `${fix.id}: done.` : `${fix.id}: did not work on this machine.`);

  const adviceId = typeof values.advice === 'string' ? values.advice : readLastAdvice();
  if (adviceId) await reportAdviceOutcome(adviceId, fix.id, ok ? 'ok' : 'error');

  printResultLine({
    command: 'fix',
    status: ok ? 'ok' : 'failed',
    version,
    fixTried: fix.id,
    retrySameCommand: false,
    nextCommand: ok ? 'npx claude-mem install' : null,
  });
  return ok ? 0 : 1;
}
