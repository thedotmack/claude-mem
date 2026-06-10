/**
 * `npx claude-mem telemetry [status|enable|disable]` — manage anonymous usage
 * analytics. Telemetry is ON by default (opt-out): anonymous events only,
 * identified by a random install UUID. Turn it off anytime with
 * `telemetry disable`, CLAUDE_MEM_TELEMETRY=0, or DO_NOT_TRACK=1.
 *
 * Full privacy documentation: https://docs.claude-mem.ai/telemetry
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  explainTelemetryConsent,
  loadTelemetryConfig,
  saveTelemetryConfig,
  getOrCreateInstallId,
  getTelemetryConfigPath,
  type TelemetryConsentSource,
} from '../../services/telemetry/consent.js';

const DOCS_URL = 'https://docs.claude-mem.ai/telemetry';

const COLLECTED_FIELDS = [
  'version          claude-mem version (e.g. 13.4.2)',
  'os               platform (darwin / linux / win32)',
  'arch             CPU architecture (arm64 / x64)',
  'runtime          bun or node',
  'runtime_version  runtime version string',
  'duration_ms      how long an operation took',
  'outcome          ok / error / partial',
  'error_category   coarse error bucket (never a message)',
  'locale           language tag (e.g. en-US)',
  'is_ci            whether running in CI',
  'endpoint         which claude-mem search route (our route names)',
  'ide              installer IDE choice (claude-code / cursor / ...)',
  'provider         LLM provider choice (claude / gemini / openrouter)',
  'runtime_mode     worker or server',
  'trigger          start or heartbeat',
  'count            integer volume (e.g. observations stored)',
  'has_summary      whether a compression produced a summary',
  'is_update        whether an install was an update',
  'mode             active claude-mem mode id',
  'model            model id used for compression',
  'hook             compression trigger (init / ingest / summarize)',
  'observation_type / obs_type_*   observation type buckets (counts only)',
  'compression_ms / tokens_input / tokens_output / compression_ratio',
  '                 latency + real token usage of one compression call',
  'observation_count / session_count / timeline_depth_days / has_session_summary',
  '                 depth of one context injection',
  'tokens_injected / tokens_saved_vs_naive / search_strategy',
  '                 token economics of one context injection',
];

const EVENT_NAMES = [
  'install_completed',
  'install_failed',
  'uninstall_completed',
  'worker_started',
  'session_compressed',
  'context_injected',
  'search_performed',
  'error_occurred',
];

const SOURCE_LABELS: Record<TelemetryConsentSource, string> = {
  DO_NOT_TRACK: 'DO_NOT_TRACK environment variable',
  env: 'CLAUDE_MEM_TELEMETRY environment variable',
  config: 'telemetry.json config file',
  default: 'default (on — no opt-out recorded)',
};

function printTelemetryUsage(): void {
  console.error(`Usage: ${pc.bold('npx claude-mem telemetry [status|enable|disable]')}`);
  console.error('  status   Show whether telemetry is on and which setting decided it (default)');
  console.error('  enable   Turn anonymous usage analytics back on (interactive)');
  console.error('  disable  Opt out of telemetry');
  console.error(`Docs: ${DOCS_URL}`);
}

function runTelemetryStatus(): void {
  // Status is read-only: it must never create telemetry.json as a side effect.
  const config = loadTelemetryConfig();
  const { enabled, source } = explainTelemetryConsent(process.env, config);

  const state = enabled ? pc.green('ENABLED') : pc.yellow('DISABLED');
  console.log(`${pc.bold('Telemetry:')} ${state}`);
  console.log(`${pc.bold('Decided by:')} ${SOURCE_LABELS[source]}`);
  if (config?.installId) {
    console.log(`${pc.bold('Install ID:')} ${config.installId} ${pc.dim('(random UUID, not tied to you)')}`);
  } else if (config) {
    console.log(`${pc.bold('Install ID:')} ${pc.dim('none recorded')}`);
  } else {
    console.log(`${pc.bold('Install ID:')} ${pc.dim('none (no telemetry config has been written)')}`);
  }
  console.log(`${pc.bold('Config file:')} ${getTelemetryConfigPath()}`);
  console.log(`${pc.bold('Docs:')} ${DOCS_URL}`);
}

async function runTelemetryEnable(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(pc.red('telemetry enable requires an interactive terminal (consent prompt).'));
    console.error(`Read what is collected first: ${DOCS_URL}`);
    process.exit(1);
  }

  p.intro(pc.bgBlue(pc.white(' claude-mem telemetry ')));

  p.note(
    [
      'Anonymous events only, identified by a random install UUID:',
      ...EVENT_NAMES.map((name) => `  ${name}`),
      '',
      'Each event carries ONLY these fields:',
      ...COLLECTED_FIELDS.map((line) => `  ${line}`),
      '',
      'NEVER collected — not now, not ever:',
      '  prompts or conversation content, file paths, source code,',
      '  project names, git remotes, search queries, error messages,',
      '  IP addresses, hardware IDs, env values, emails.',
      '',
      `Full details: ${DOCS_URL}`,
    ].join('\n'),
    'What telemetry collects'
  );

  if (process.env.DO_NOT_TRACK && process.env.DO_NOT_TRACK !== '0' && process.env.DO_NOT_TRACK !== 'false') {
    p.log.warn(
      'DO_NOT_TRACK is set in your environment. It overrides everything: telemetry will remain OFF even after enabling here.'
    );
  }

  const shouldEnable = await p.confirm({
    message: 'Enable anonymous usage telemetry?',
    initialValue: true,
  });

  if (p.isCancel(shouldEnable) || !shouldEnable) {
    p.cancel('Telemetry remains disabled. Nothing was written.');
    return;
  }

  // getOrCreateInstallId() persists a config if none exists; reuse its ID.
  const installId = getOrCreateInstallId();
  saveTelemetryConfig({
    enabled: true,
    installId,
    decidedAt: new Date().toISOString(),
  });

  p.log.success(`Telemetry enabled. Config: ${getTelemetryConfigPath()}`);
  p.outro(`Change your mind anytime: ${pc.cyan('npx claude-mem telemetry disable')}`);
}

function runTelemetryDisable(): void {
  const existing = loadTelemetryConfig();
  saveTelemetryConfig({
    enabled: false,
    installId: existing?.installId ?? '',
    decidedAt: new Date().toISOString(),
  });

  console.log(pc.green('Telemetry disabled.'));
  console.log(`${pc.bold('Config file:')} ${getTelemetryConfigPath()}`);
}

export async function runTelemetryCommand(argv: string[] = []): Promise<void> {
  const subCommand = argv[0]?.toLowerCase() ?? 'status';

  switch (subCommand) {
    case 'status':
      runTelemetryStatus();
      break;
    case 'enable':
      await runTelemetryEnable();
      break;
    case 'disable':
      runTelemetryDisable();
      break;
    default:
      console.error(pc.red(`Unknown telemetry subcommand: ${subCommand}`));
      printTelemetryUsage();
      process.exit(1);
  }
}
