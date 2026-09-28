/**
 * `npx claude-mem advisor plan [--snapshot -] [--collect] [--json]`
 * `npx claude-mem advisor fix  [--snapshot -] [--collect] [--json]`
 *
 * Asks the Claude-Mem install advisor on cmem.ai for steps built for this
 * setup. The snapshot comes from the user's agent on stdin (`--snapshot -`)
 * or from our own local collector (`--collect`, no LLM). Either way it is
 * redacted here first, and the exact JSON is printed before it is sent.
 * Our model never runs anything: the answer is steps and allowlisted fix ids
 * that the user's agent (or the person) chooses to run.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'node:util';
import { resolveDataDir } from '../../shared/paths.js';
import { readPluginVersion, marketplaceDirectory } from '../utils/paths.js';
import { getOrCreateInstallId } from '../../services/telemetry/consent.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import {
  collectSnapshot,
  readInstalledPluginVersion,
  redactSnapshot,
  scrubErrorSnippet,
  type SnapshotV1,
} from '../install/snapshot.js';
import {
  parseAdvisorAnswer,
  postAdvisor,
  saveLastAdvice,
  type AdvisorAnswer,
} from '../install/advisor-client.js';
import { printResultLine, readLastResult } from '../install/result-line.js';
import { detectAgentContext } from '../install/install-steps.js';
import { getBunVersion, getUvVersion } from '../install/setup-runtime.js';
import { detectInstalledIDEs } from './ide-detection.js';

const STANDARD_STEPS = [
  { text: 'Sign-in (needs the person, free): npx claude-mem login --request', command: 'npx claude-mem login --request' },
  { text: 'Install on the person\'s own Anthropic plan: npx claude-mem install --provider claude', command: 'npx claude-mem install --provider claude' },
];

function safeVersion(): string {
  try {
    return readPluginVersion();
  } catch {
    // [ANTI-PATTERN IGNORED]: the version is only reported; advice does not depend on it.
    return 'unknown';
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) break;
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function localSnapshot(): SnapshotV1 {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return collectSnapshot({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    nodeVersion: process.versions.node,
    isTTY: process.stdin.isTTY === true,
    bunVersion: getBunVersion(),
    uvVersion: getUvVersion(),
    aiToolIds: detectInstalledIDEs().filter((ide) => ide.detected).map((ide) => ide.id),
    agentContext: detectAgentContext(process.env, process.stdin.isTTY === true),
    installedVersion: readInstalledPluginVersion(marketplaceDirectory()),
    provider: settings.CLAUDE_MEM_PROVIDER || null,
    installId: getOrCreateInstallId(),
  });
}

/** The snapshot to send: the agent's (stdin) or ours (--collect), always redacted. */
async function resolveSnapshot(fromStdin: boolean): Promise<SnapshotV1 | { error: string }> {
  if (!fromStdin) return localSnapshot();
  const text = await readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'The snapshot on stdin is not valid JSON.' };
  }
  const snapshot = redactSnapshot(parsed);
  // The advisor keys installs by the same anonymous id as telemetry; an agent
  // may omit it.
  return snapshot.install_id ? snapshot : { ...snapshot, install_id: getOrCreateInstallId() };
}

interface InstallErrorRecord {
  categoryId?: unknown;
  cause?: unknown;
  details?: unknown;
  remediation?: unknown;
}

function readLastInstallError(): InstallErrorRecord | null {
  try {
    const path = join(resolveDataDir(), 'last-install-error.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) as InstallErrorRecord : null;
  } catch {
    // [ANTI-PATTERN IGNORED]: no readable error record means `advisor fix` has nothing to explain.
    return null;
  }
}

function printAnswer(answer: AdvisorAnswer): void {
  console.log(`\nSetup ${answer.fixId ? 'fix' : 'plan'} from the Claude-Mem install advisor (source: ${answer.source}):`);
  answer.steps.forEach((step, i) => {
    const label = step.humanActionRequired === 'sign-in' ? `${step.id} (needs the person)` : step.id;
    console.log(`  ${i + 1}. ${label}${step.when ? ` — when ${step.when}` : ''}`);
    if (step.forTheUser) console.log(`     ${step.forTheUser}`);
    if (step.command) console.log(`     ${step.command}`);
  });
  if (answer.notes) console.log(`Notes: ${answer.notes}`);
  if (answer.droppedCommands > 0) {
    console.log(`(${answer.droppedCommands} suggested command(s) were not on the allowed list and were left out.)`);
  }
}

export async function runAdvisorCommand(argv: string[]): Promise<number> {
  const mode = argv[0];
  const { values } = parseArgs({
    args: argv.slice(1),
    options: { snapshot: { type: 'string' }, collect: { type: 'boolean' }, json: { type: 'boolean' } },
    strict: false,
    allowPositionals: true,
  });
  const version = safeVersion();
  if ((mode !== 'plan' && mode !== 'fix') || (values.snapshot !== undefined && values.snapshot !== '-')) {
    console.error('Usage: npx claude-mem advisor plan|fix [--snapshot -] [--collect] [--json]');
    return 1;
  }
  const fromStdin = values.snapshot === '-';
  if (!fromStdin && values.collect !== true) {
    console.error('Pass the snapshot on stdin with `--snapshot -`, or `--collect` to let claude-mem collect it.');
    return 1;
  }

  const snapshot = await resolveSnapshot(fromStdin);
  if ('error' in snapshot) {
    console.error(snapshot.error);
    printResultLine({ command: 'advisor', status: 'failed', version, errorCategory: 'snapshot-invalid' });
    return 1;
  }

  let body: Record<string, unknown> = { snapshot };
  let fallbackRemediation: string | null = null;
  if (mode === 'fix') {
    const last = readLastResult();
    const lastError = readLastInstallError();
    fallbackRemediation = typeof lastError?.remediation === 'string' ? lastError.remediation : null;
    body = {
      snapshot,
      failed_step: last?.failed_step ?? null,
      error_category: last?.error_category ?? (typeof lastError?.categoryId === 'string' ? lastError.categoryId : null),
      error_snippet: scrubErrorSnippet([lastError?.cause, lastError?.details].filter((v) => typeof v === 'string').join('\n')),
    };
  }

  // Show exactly what leaves the machine, before it leaves.
  console.log(`Sending to cmem.ai/api/installer/${mode}:`);
  console.log(JSON.stringify(body, null, 2));

  const answer = parseAdvisorAnswer(await postAdvisor(mode, body));
  if (!answer) {
    console.log('\nNo advice available right now (cmem.ai did not answer in time, or advice is turned off).');
    if (mode === 'fix' && fallbackRemediation) {
      console.log(`Manual fix from the installer: ${fallbackRemediation}`);
    } else {
      console.log('Standard steps:');
      STANDARD_STEPS.forEach((s, i) => console.log(`  ${i + 1}. ${s.text}`));
    }
    printResultLine({
      command: 'advisor',
      status: 'failed',
      version,
      errorCategory: 'advisor-unavailable',
      nextCommand: mode === 'plan' ? STANDARD_STEPS[1].command : null,
    });
    return 1;
  }

  saveLastAdvice(answer.adviceId);
  if (values.json === true) {
    process.stdout.write(JSON.stringify({
      advice_id: answer.adviceId,
      source: answer.source,
      fix_id: answer.fixId,
      steps: answer.steps.map((s) => ({
        id: s.id, command: s.command, for_the_user: s.forTheUser, human_action_required: s.humanActionRequired, when: s.when,
      })),
      notes: answer.notes,
    }) + '\n');
    return 0;
  }
  printAnswer(answer);
  const first = answer.steps.find((s) => s.command);
  printResultLine({
    command: 'advisor',
    status: 'ok',
    version,
    nextCommand: first?.command ?? null,
    humanActionRequired: answer.steps.some((s) => s.humanActionRequired === 'sign-in') ? 'sign-in' : null,
  });
  return 0;
}

/** The consent question for a person in a terminal (Path 2). The default is No. */
export const TTY_PLAN_OFFER = 'Get a setup plan from the Claude-Mem install agent? It sends your OS, CPU type, shell, and tool versions (Node, bun, uv, installed AI coding tools). No file paths, names, keys or file contents. Details: docs.claude-mem.ai/telemetry';

/**
 * Path 2: an interactive install may offer a plan. Our code collects the
 * snapshot (no LLM), shows it, and sends it only after a yes. The install
 * continues the same way whatever the answer; the plan is advice to read.
 */
export async function offerSetupPlan(confirm: (message: string) => Promise<boolean>): Promise<void> {
  if (!(await confirm(TTY_PLAN_OFFER))) return;
  const snapshot = localSnapshot();
  console.log('Sending to cmem.ai/api/installer/plan:');
  console.log(JSON.stringify({ snapshot }, null, 2));
  const answer = parseAdvisorAnswer(await postAdvisor('plan', { snapshot }));
  if (!answer) {
    console.log('No advice available right now; continuing with the standard install.');
    return;
  }
  saveLastAdvice(answer.adviceId);
  printAnswer(answer);
}
